import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeModel, type CompletionRequest } from "./fake-model";
import { latestComputerScreenshot } from "../agent/lib/computer-context";

const exec = promisify(execFile);
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S8AAAAASUVORK5CYII=";
const newerPng =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for the production computer worker.");
}

function imageUrls(request: CompletionRequest): string[] {
  return request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) => {
          if (
            part &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "image_url" &&
            "image_url" in part &&
            part.image_url &&
            typeof part.image_url === "object" &&
            "url" in part.image_url &&
            typeof part.image_url.url === "string"
          )
            return [part.image_url.url];
          return [];
        })
      : [],
  );
}

test("computer image pruning preserves user files, other tools, and durable history", () => {
  type Prompt = Parameters<typeof latestComputerScreenshot>[0];
  const file = (data: string) => ({
    type: "file" as const,
    filename: "desktop.png",
    mediaType: "image/png",
    data: { type: "data" as const, data },
  });
  const result = (
    name: string,
    id: string,
    value: Extract<
      Extract<Prompt[number], { role: "tool" }>["content"][number],
      { type: "tool-result" }
    >["output"],
  ) => ({
    type: "tool-result" as const,
    toolName: name,
    toolCallId: id,
    output: value,
  });
  const moved = (name: string, id: string) =>
    result(name, id, {
      type: "content",
      value: [
        {
          type: "text",
          text: "Attached file desktop.png (image/png) follows this tool result.",
        },
      ],
    });
  const returned = (files: ReturnType<typeof file>[]): Prompt[number] => ({
    role: "user",
    content: [
      { type: "text", text: "Files returned by the preceding tool results:" },
      ...files,
    ],
  });
  const prompt: Prompt = [
    { role: "user", content: [file("user attachment")] },
    {
      role: "tool",
      content: [
        result("computer", "first", {
          type: "content",
          value: [file("old direct frame")],
        }),
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Inspect again." }] },
    {
      role: "tool",
      content: [moved("another_tool", "other"), moved("computer", "second")],
    },
    returned([file("other tool image"), file("old moved frame")]),
    {
      role: "assistant",
      content: [{ type: "text", text: "Inspect one more time." }],
    },
    { role: "tool", content: [moved("computer", "third")] },
    returned([file("latest frame")]),
  ];
  const original = structuredClone(prompt);
  const projected = latestComputerScreenshot(prompt);
  const serialized = JSON.stringify(projected);
  assert(!serialized.includes("old direct frame"));
  assert(!serialized.includes("old moved frame"));
  assert(serialized.includes("latest frame"));
  assert(serialized.includes("user attachment"));
  assert(serialized.includes("other tool image"));
  assert.deepEqual(
    prompt,
    original,
    "Model pruning must not edit stored history.",
  );
});

test(
  "production Eve gives a vision worker actual screenshot pixels and hides desktop input from other roles",
  {
    // Eve stages multimodal tool files in its production Docker sandbox.
    skip:
      process.env.CIT_TEST_EVE !== "1" || process.env.CIT_TEST_DOCKER !== "1",
    timeout: 90_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cit-computer-eve-"));
    const token = "isolated-computer-eve-test-token";
    let worker: ChildProcess | undefined;
    let logs = "";
    let screenshots = 0;
    let coderRequests = 0;
    const sessionIds: string[] = [];
    const fixtures: Record<
      string,
      {
        role: string;
        isDotCoordinator: boolean;
        vision: boolean;
        owned: boolean;
      }
    > = {
      vision_coder: {
        role: "coder",
        isDotCoordinator: false,
        vision: true,
        owned: true,
      },
      vision_parent: {
        role: "coordinator",
        isDotCoordinator: true,
        vision: true,
        owned: true,
      },
      text_coder: {
        role: "coder",
        isDotCoordinator: false,
        vision: false,
        owned: true,
      },
      vision_reviewer: {
        role: "reviewer",
        isDotCoordinator: false,
        vision: true,
        owned: true,
      },
      independent_coder: {
        role: "coder",
        isDotCoordinator: false,
        vision: true,
        owned: false,
      },
    };
    const fake = await createFakeModel({
      models: Object.keys(fixtures),
      respond(request) {
        if (request.model !== "vision_coder")
          return { text: "The descriptor fixture completed." };
        coderRequests++;
        if (coderRequests === 1)
          return {
            tool: { name: "computer", input: { action: "screenshot" } },
          };
        assert(coderRequests <= 3, "The two screenshots should settle once.");
        const latestPng = coderRequests === 2 ? png : newerPng;
        assert.deepEqual(
          imageUrls(request),
          [`data:image/png;base64,${latestPng}`],
          "The local provider must receive only the latest PNG pixels as an image_url content part.",
        );
        const plainText = request.messages
          .filter((message) => typeof message.content === "string")
          .map((message) => message.content)
          .join("\n");
        assert(
          !plainText.includes(png) && !plainText.includes(newerPng),
          "Pixels must not become base64 prose.",
        );
        if (coderRequests === 2)
          return {
            tool: { name: "computer", input: { action: "screenshot" } },
          };
        assert(
          !JSON.stringify(request.messages).includes(png),
          "The older screenshot bytes must be pruned before HTTP serialization.",
        );
        return {
          text: "I received and verified the desktop screenshot pixels.",
        };
      },
    });
    const control = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      try {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (url.pathname === "/api/internal/worker-context") {
          const taskId = url.searchParams.get("taskId") || "";
          const fixture = fixtures[taskId];
          assert(fixture, "Only test-created worker identities are allowed.");
          response.end(
            JSON.stringify({
              taskId,
              role: fixture.role,
              isDotCoordinator: fixture.isDotCoordinator,
              dot: fixture.owned
                ? { id: "dot-primary", name: "Pip", personality: "Practical." }
                : null,
              instructions:
                "Complete the current computer integration fixture.",
              messages: [],
              memory: "",
              model: {
                modelId: taskId,
                baseUrl: fake.baseUrl,
                contextWindow: 32768,
                maxOutputTokens: 1024,
                temperature: 0,
                vision: fixture.vision,
              },
            }),
          );
          return;
        }
        if (url.pathname === "/api/internal/tool") {
          let body = "";
          for await (const chunk of request) body += chunk;
          const call = JSON.parse(body);
          assert.equal(call.taskId, "vision_coder");
          assert.equal(call.toolName, "computer");
          assert.deepEqual(call.input, { action: "screenshot" });
          screenshots++;
          response.end(
            JSON.stringify({
              result: {
                action: "screenshot",
                width: screenshots === 1 ? 1 : 64,
                height: screenshots === 1 ? 1 : 64,
                cursor: { x: 0, y: 0 },
                image: {
                  mimeType: "image/png",
                  data: screenshots === 1 ? png : newerPng,
                },
              },
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "Unknown fixture route." }));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: (error as Error).message }));
      }
    });
    await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
    const controlAddress = control.address();
    assert(controlAddress && typeof controlAddress !== "string");
    const portFinder = createServer();
    await new Promise<void>((done) => portFinder.listen(0, "127.0.0.1", done));
    const address = portFinder.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((done) => portFinder.close(() => done()));
    const env = {
      CIT_CONTROL_URL: `http://127.0.0.1:${controlAddress.port}`,
      CIT_EVE_URL: `http://127.0.0.1:${port}`,
      CIT_INTERNAL_TOKEN: token,
      CIT_DATA_DIR: join(directory, "application"),
      WORKFLOW_LOCAL_DATA_DIR: join(directory, ".eve", ".workflow-data"),
      WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`,
      WORKFLOW_TARGET_WORLD: "local",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    try {
      const runtime = await import("../src/server/eve-worker");
      worker = spawn(process.execPath, [resolve(".output/server/index.mjs")], {
        cwd: directory,
        env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const capture = (data: Buffer) => {
        logs = (logs + data.toString()).slice(-20_000);
      };
      worker.stdout?.on("data", capture);
      worker.stderr?.on("data", capture);
      await until(() => runtime.workerHealth());
      for (const taskId of Object.keys(fixtures)) {
        const sessionId = await runtime.createWorkerSession(taskId);
        sessionIds.push(sessionId);
        await runtime.sendWorkerMessage(
          sessionId,
          taskId,
          "Complete this fixture.",
        );
        let completed = false;
        let text = "";
        for await (const event of runtime.streamWorkerSession(
          sessionId,
          taskId,
          0,
          AbortSignal.timeout(30_000),
        )) {
          assert.notEqual(event.type, "failed", event.error);
          if (event.type === "completed") completed = true;
          if (event.type === "text") text += event.text;
        }
        assert(completed, `${taskId} must reach a completed worker turn.`);
        if (taskId === "vision_coder") assert.match(text, /screenshot pixels/);
      }
      assert.equal(screenshots, 2);
      assert.equal(coderRequests, 3);
      const first = (taskId: string) => {
        const request = fake.requests.find(
          (request) => request.model === taskId,
        );
        assert(request);
        return request;
      };
      const tool = (taskId: string) =>
        first(taskId).tools?.find((tool) => tool.function.name === "computer");
      assert(tool("vision_coder"));
      for (const taskId of ["vision_parent", "text_coder", "independent_coder"])
        assert(
          !tool(taskId),
          `${taskId} must not see the graphical computer tool.`,
        );
      const reviewer = tool("vision_reviewer");
      assert(reviewer);
      const schema = reviewer.function.parameters;
      assert(schema);
      assert.deepEqual(schema.properties, {
        action: { type: "string", const: "screenshot" },
      });
      assert.deepEqual(schema.required, ["action"]);
      assert.equal(schema.additionalProperties, false);
      assert(
        !first("vision_parent").tools?.some((tool) =>
          ["read_file", "write_file", "run_command", "list_files"].includes(
            tool.function.name,
          ),
        ),
      );
    } catch (error) {
      throw new Error(`${(error as Error).message}\nWorker output:\n${logs}`, {
        cause: error,
      });
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const exited = new Promise<void>((done) => worker!.once("exit", done));
        try {
          process.kill(-worker.pid!, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await Promise.race([exited, delay(3000)]);
      }
      // Remove only sandboxes labeled with exact session IDs created by this test.
      for (const sessionId of sessionIds) {
        const owned = await exec("docker", [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=eve.sandbox.tag.sessionId=${sessionId}`,
        ]);
        const containers = owned.stdout.trim().split(/\s+/).filter(Boolean);
        if (containers.length)
          await exec("docker", ["rm", "--force", ...containers]);
      }
      control.closeAllConnections();
      await new Promise<void>((done) => control.close(() => done()));
      await fake.close();
      await rm(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
