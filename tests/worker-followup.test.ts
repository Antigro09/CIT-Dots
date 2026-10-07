import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeModel } from "./fake-model";

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for worker execution.");
}

test(
  "production worker preserves queued and steered prompts in one existing session",
  { skip: process.env.CIT_TEST_EVE !== "1", timeout: 45_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cit-worker-followup-"));
    const token = "isolated-worker-followup-test-token";
    let worker: ChildProcess | undefined;
    let logs = "";
    const fake = await createFakeModel({
      respond(request) {
        const latest = request.messages
          .filter((message) => message.role === "user")
          .at(-1)?.content;
        const text =
          typeof latest === "string" ? latest : JSON.stringify(latest);
        if (text?.includes("STEER_CORRECTION"))
          return { text: "Steered worker completed." };
        if (text?.includes("QUEUED_FOLLOWUP"))
          return { text: "Queued follow-up completed." };
        return { text: "Initial worker completed.", delayMs: 1000 };
      },
    });
    const control = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "Internal token required." }));
        return;
      }
      if (!request.url?.startsWith("/api/internal/worker-context")) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "Unknown fixture route." }));
        return;
      }
      response.end(
        JSON.stringify({
          taskId: "followup_worker",
          role: "coder",
          isDotCoordinator: false,
          dot: null,
          instructions: "Respond to the latest fixture message.",
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
      worker.stdout?.on("data", (chunk) => (logs += String(chunk)));
      worker.stderr?.on("data", (chunk) => (logs += String(chunk)));
      await until(() => runtime.workerHealth());
      const sessionId = await runtime.createWorkerSession("followup_worker");
      let cursor = 0;
      async function completeTurn() {
        let text = "";
        let boundary:
          import("../src/server/eve-worker").WorkerEvent | undefined;
        for await (const event of runtime.streamWorkerSession(
          sessionId,
          "followup_worker",
          cursor,
          AbortSignal.timeout(20_000),
        )) {
          cursor = event.cursor ?? cursor;
          assert.notEqual(event.type, "failed", event.error);
          if (event.type === "text") text += event.text;
          if (event.type === "completed") boundary = event;
        }
        assert(boundary, "Each response must end at a durable turn boundary.");
        return { text, boundary };
      }

      const first = await runtime.sendWorkerMessage(
        sessionId,
        "followup_worker",
        "INITIAL_QUEUE_WORK",
      );
      assert(first);
      await until(() => fake.requests.length === 1);
      const queued = await runtime.sendWorkerMessage(
        sessionId,
        "followup_worker",
        "QUEUED_FOLLOWUP",
        "queue",
      );
      assert(queued);
      const initialTurn = await completeTurn();
      assert.match(initialTurn.text, /Initial worker completed/);
      assert(initialTurn.boundary.deliveryIds?.includes(first.deliveryId));
      assert(!initialTurn.boundary.deliveryIds?.includes(queued.deliveryId));
      const queuedTurn = await completeTurn();
      assert.match(queuedTurn.text, /Queued follow-up completed/);
      assert(queuedTurn.boundary.deliveryIds?.includes(queued.deliveryId));
      assert.notEqual(queuedTurn.boundary.turnId, initialTurn.boundary.turnId);

      const beforeSteering = fake.requests.length;
      const original = await runtime.sendWorkerMessage(
        sessionId,
        "followup_worker",
        "INITIAL_STEER_WORK",
      );
      assert(original);
      await until(() => fake.requests.length > beforeSteering);
      const correction = await runtime.sendWorkerMessage(
        sessionId,
        "followup_worker",
        "STEER_CORRECTION",
        "steer",
      );
      assert(correction);
      const correctedTurn = await completeTurn();
      assert.match(correctedTurn.text, /Steered worker completed/);
      assert(!correctedTurn.text.includes("Initial worker completed"));
      assert(correctedTurn.boundary.deliveryIds?.includes(original.deliveryId));
      assert(
        correctedTurn.boundary.deliveryIds?.includes(correction.deliveryId),
      );
      assert.equal(fake.requests.length, 4);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${logs.slice(-4000)}`,
        { cause: error },
      );
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const exited = new Promise<void>((done) => worker!.once("exit", done));
        try {
          process.kill(-worker.pid!, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await Promise.race([exited, delay(1500)]);
      }
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
