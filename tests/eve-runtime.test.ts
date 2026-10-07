import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeModel } from "./fake-model";

async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test(
  "production Eve uses local tools and resumes a parked approval after SIGKILL",
  {
    skip: process.env.CIT_TEST_EVE !== "1",
    timeout: 90_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cit-eve-runtime-"));
    const fake = await createFakeModel();
    let approved = false;
    let polls = 0;
    let toolCalls = 0;
    let worker: ChildProcess | undefined;
    let logs = "";
    const token = "isolated-eve-test-token";
    const control = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "Internal token required." }));
        return;
      }
      if (request.url?.startsWith("/api/internal/worker-context")) {
        response.end(
          JSON.stringify({
            taskId: "runtime_test",
            role: "coordinator",
            instructions: "Complete the local fixture objective.",
            memory: "",
            messages: [],
            model: {
              modelId: "fixture-chat",
              baseUrl: fake.baseUrl,
              contextWindow: 32768,
              maxOutputTokens: 1024,
              temperature: 0,
            },
          }),
        );
        return;
      }
      if (request.url === "/api/internal/tool") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const action = JSON.parse(body) as {
          toolName: string;
          input: { question: string };
        };
        assert.equal(action.toolName, "ask_user");
        assert.match(action.input.question, /branch/);
        toolCalls += 1;
        response.end(
          JSON.stringify({
            approval: { id: "test_approval", prompt: action.input.question },
          }),
        );
        return;
      }
      if (request.url?.startsWith("/api/internal/tool-result")) {
        polls += 1;
        response.end(
          JSON.stringify(
            approved
              ? { status: "completed", result: { answer: "local-test-branch" } }
              : { status: "pending" },
          ),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Unknown test route." }));
    });
    await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
    const controlAddress = control.address();
    assert(controlAddress && typeof controlAddress !== "string");
    const port = await unusedPort();
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
    const start = () => {
      // Eve's generated runtime chooses its local Workflow directory from cwd.
      // Run the production Node output in a private cwd to isolate all sessions.
      worker = spawn(process.execPath, [resolve(".output/server/index.mjs")], {
        cwd: directory,
        env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const capture = (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-20_000);
      };
      worker.stdout?.on("data", capture);
      worker.stderr?.on("data", capture);
      worker.on("error", (error) => {
        logs += String(error);
      });
    };
    const stop = async () => {
      const active = worker;
      worker = undefined;
      if (!active || active.exitCode !== null || active.signalCode !== null)
        return;
      const ended = new Promise<void>((done) =>
        active.once("exit", () => done()),
      );
      try {
        process.kill(-active.pid!, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await Promise.race([ended, delay(3000)]);
    };
    try {
      const runtime = await import("../src/server/eve-worker");
      start();
      await until(() => runtime.workerHealth(), "production worker health");
      const ordinarySession = await runtime.createWorkerSession("runtime_chat");
      await runtime.sendWorkerMessage(
        ordinarySession,
        "runtime_chat",
        "fixture:chat Say hello.",
      );
      let chat = "",
        completed = false;
      for await (const event of runtime.streamWorkerSession(
        ordinarySession,
        "runtime_chat",
        0,
        AbortSignal.timeout(15_000),
      )) {
        if (event.type === "text") chat += event.text;
        if (event.type === "completed") completed = true;
        assert.notEqual(event.type, "failed", event.error);
      }
      assert(completed);
      assert.match(chat, /Local fixture reply/);
      const tools =
        fake.requests[0].tools?.map((tool) => tool.function.name) ?? [];
      assert(tools.includes("ask_user") && tools.includes("delegate"));
      assert(
        !tools.includes("bash") &&
          !tools.includes("web_fetch") &&
          !tools.includes("agent"),
      );

      const sessionId = await runtime.createWorkerSession("runtime_approval");
      await runtime.sendWorkerMessage(
        sessionId,
        "runtime_approval",
        "fixture:question Ask which branch.",
      );
      let cursor = 0;
      const detach = new AbortController();
      const watching = (async () => {
        try {
          for await (const event of runtime.streamWorkerSession(
            sessionId,
            "runtime_approval",
            0,
            detach.signal,
          )) {
            cursor = event.cursor ?? cursor;
            assert.notEqual(
              event.type,
              "completed",
              "Unapproved work must remain parked.",
            );
            assert.notEqual(event.type, "failed", event.error);
          }
        } catch (error) {
          if (!detach.signal.aborted) throw error;
        }
      })();
      await until(() => polls > 0, "durable approval polling");
      detach.abort();
      await watching;
      assert(cursor > 0);
      assert.equal(toolCalls, 1);
      const requestsBeforeRestart = fake.requests.length;
      const pollsBeforeRestart = polls;
      assert(
        (await readdir(env.WORKFLOW_LOCAL_DATA_DIR)).length > 0,
        "Workflow state must use the isolated directory.",
      );
      await stop();
      start();
      await until(
        () => runtime.workerHealth(),
        "restarted production worker health",
      );
      await until(
        () => polls > pollsBeforeRestart,
        "pending workflow recovery",
      );
      approved = true;
      let answer = "",
        finished = false;
      for await (const event of runtime.streamWorkerSession(
        sessionId,
        "runtime_approval",
        cursor,
        AbortSignal.timeout(20_000),
      )) {
        if (event.type === "text") answer += event.text;
        if (event.type === "completed") finished = true;
        assert.notEqual(event.type, "failed", event.error);
      }
      assert(finished);
      assert.match(answer, /recorded your branch answer/);
      assert.equal(
        toolCalls,
        1,
        "Recovery must not repeat the initial tool action.",
      );
      assert.equal(
        fake.requests.length,
        requestsBeforeRestart + 1,
        "Recovery must preserve the completed model step.",
      );
    } catch (error) {
      throw new Error(`${(error as Error).message}\nWorker output:\n${logs}`, {
        cause: error,
      });
    } finally {
      await stop();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fake.close();
      control.closeAllConnections();
      await new Promise<void>((done) => control.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
