import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker, type WorkerClient } from "../src/server/broker";
import { Store } from "../src/server/store";
import type { WorkerEvent } from "../src/server/eve-worker";
import type { Message, ModelProfile, Task } from "../src/shared/types";

function fixture(t: test.TestContext, events: WorkerEvent[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "cit-recovery-"));
  const store = new Store(join(directory, "cit.sqlite"));
  const calls = {
    created: [] as string[],
    sent: [] as string[],
    canceled: [] as string[],
    streams: [] as number[],
  };
  const worker: WorkerClient = {
    async createWorkerSession(taskId) {
      calls.created.push(taskId);
      return `eve-${taskId}`;
    },
    async sendWorkerMessage(sessionId) {
      calls.sent.push(sessionId);
    },
    async cancelWorkerSession(sessionId) {
      calls.canceled.push(sessionId);
    },
    async workerHealth() {
      return false;
    },
    async *streamWorkerSession(_sessionId, _taskId, after) {
      calls.streams.push(after ?? 0);
      for (const event of events) yield event;
    },
  };
  const broker = new Broker({
    store,
    worker,
    config: { dataDir: directory, tickMs: 60_000 },
  });
  broker.updateSettings({ paused: true });
  const model = store.insert<ModelProfile>("models", {
    name: "Test local model",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "fixture",
    contextWindow: 8192,
    maxOutputTokens: 2048,
    temperature: 0.2,
    capabilities: { streaming: true, tools: true },
  });
  const session = broker.createSession({
    title: "Recovery test",
    modelProfileId: model.id,
  });
  const task = broker.createTask({
    sessionId: session.id,
    modelProfileId: model.id,
    prompt: "Investigate the project",
    goalId: "background-goal",
  });
  t.after(async () => {
    await broker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { broker, store, worker, calls, task, session };
}

test("restart resumes a confirmed delivery from its committed cursor without resending the prompt", async (t) => {
  const { broker, store, calls, task, session } = fixture(t, [
    { type: "text", text: " duplicate", cursor: 5 },
    { type: "text", text: " and verified", cursor: 6 },
    { type: "completed", cursor: 7 },
  ]);
  const output = store.addMessage<Message>(session.id, {
    role: "assistant",
    content: "Implemented",
    taskId: task.id,
    kind: "chat",
  });
  const deadline = new Date(Date.now() + 30_000).toISOString();
  store.update<Task>("tasks", task.id, {
    status: "running",
    eveSessionId: "existing-session",
    promptDispatch: "sent",
    assistantMessageId: output.id,
    cursor: 5,
    deadlineAt: deadline,
  });
  await broker.start();
  assert.equal(store.require<Task>("tasks", task.id).status, "queued");
  await broker.runTask(task.id, new AbortController().signal);
  const completed = store.require<Task>("tasks", task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "Implemented and verified");
  assert.equal(completed.cursor, 7);
  assert.equal(completed.deadlineAt, deadline);
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.sent, []);
  assert.deepEqual(calls.streams, [5]);
  assert.equal(
    store.list<{ body: string }>("inbox", {
      predicate: (item) => item.body === "Implemented and verified",
    }).length,
    1,
  );
});

test("uncertain prompt dispatch is interrupted and canceled instead of blindly replayed", async (t) => {
  const { broker, store, calls, task } = fixture(t);
  store.update<Task>("tasks", task.id, {
    status: "running",
    eveSessionId: "uncertain-session",
    promptDispatch: "sending",
  });
  await broker.start();
  const interrupted = store.require<Task>("tasks", task.id);
  assert.equal(interrupted.status, "interrupted");
  assert.match(interrupted.error!, /delivery is uncertain/);
  assert.deepEqual(calls.sent, []);
  assert.deepEqual(calls.streams, []);
  assert.deepEqual(calls.canceled, ["uncertain-session"]);
  assert.equal(store.list("inbox").length, 1);
});

test("interrupting uncertain root delivery also stops child sessions during restart", async (t) => {
  const { broker, store, calls, task } = fixture(t);
  const childSession = broker.createSession({
    title: "Child investigation",
    modelProfileId: task.modelProfileId,
  });
  const child = broker.createTask({
    sessionId: childSession.id,
    parentId: task.id,
    prompt: "Investigate one file",
    role: "investigator",
  });
  store.update<Task>("tasks", child.id, {
    status: "running",
    eveSessionId: "child-session",
    promptDispatch: "sent",
  });
  store.update<Task>("tasks", task.id, {
    status: "running",
    eveSessionId: "uncertain-root",
    promptDispatch: "sending",
  });
  // The root is recovered first; the following child entry in the startup snapshot is now stale.
  store.db
    .prepare(
      "UPDATE records SET updated_at = ? WHERE collection = 'tasks' AND id = ?",
    )
    .run("2099-01-01T00:00:00.000Z", task.id);
  await broker.start();
  assert.equal(store.require<Task>("tasks", task.id).status, "interrupted");
  assert.equal(store.require<Task>("tasks", child.id).status, "canceled");
  assert.ok(calls.canceled.includes("uncertain-root"));
  assert.ok(calls.canceled.includes("child-session"));
  assert.deepEqual(calls.sent, []);
});

test("a restored approval wait stays attached to its existing session", async (t) => {
  const { broker, store, calls, task } = fixture(t, [
    { type: "text", text: "Continued after approval", cursor: 4 },
    { type: "completed", cursor: 5 },
  ]);
  store.update<Task>("tasks", task.id, {
    status: "waiting_approval",
    eveSessionId: "waiting-session",
    promptDispatch: "sent",
    cursor: 3,
  });
  await broker.start();
  assert.equal(
    store.require<Task>("tasks", task.id).status,
    "waiting_approval",
  );
  await broker.runTask(task.id, new AbortController().signal);
  assert.equal(store.require<Task>("tasks", task.id).status, "completed");
  assert.deepEqual(calls.sent, []);
  assert.deepEqual(calls.streams, [3]);
});

test("canceling during worker-session creation prevents prompt dispatch", async (t) => {
  const { broker, store, worker, calls, task } = fixture(t);
  let finishCreation!: (sessionId: string) => void;
  worker.createWorkerSession = () =>
    new Promise((resolve) => {
      finishCreation = resolve;
    });
  const run = broker.runTask(task.id, new AbortController().signal);
  await broker.cancelTask(task.id);
  finishCreation("late-session");
  await run;
  assert.equal(store.require<Task>("tasks", task.id).status, "canceled");
  assert.deepEqual(calls.sent, []);
  assert.deepEqual(calls.canceled, ["late-session"]);
});

test("canceling during initial send preserves cancellation and never starts a response stream", async (t) => {
  const { broker, store, worker, calls, task } = fixture(t);
  let finishSend!: () => void;
  let announceSend!: () => void;
  const started = new Promise<void>((resolve) => {
    announceSend = resolve;
  });
  worker.sendWorkerMessage = async () => {
    announceSend();
    await new Promise<void>((resolve) => {
      finishSend = resolve;
    });
  };
  const run = broker.runTask(task.id, new AbortController().signal);
  await started;
  await broker.cancelTask(task.id);
  finishSend();
  await run;
  assert.equal(store.require<Task>("tasks", task.id).status, "canceled");
  assert.deepEqual(calls.streams, []);
  assert.ok(calls.canceled.length >= 1);
});

test("a message write failure rolls back its cursor and partial assistant record", async (t) => {
  const { broker, store, task } = fixture(t, [
    { type: "text", text: "Must roll back", cursor: 1 },
  ]);
  store.update<Task>("tasks", task.id, {
    eveSessionId: "existing",
    promptDispatch: "sent",
    cursor: 0,
  });
  const originalEvent = store.event.bind(store);
  store.event = (type, data, taskId, sessionId) => {
    if (type === "message.delta") throw new Error("simulated audit failure");
    return originalEvent(type, data, taskId, sessionId);
  };
  await broker.runTask(task.id, new AbortController().signal);
  const failed = store.require<Task>("tasks", task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.cursor, 0);
  assert.equal(failed.assistantMessageId, undefined);
  assert.equal(
    store.list<Message>("messages", {
      predicate: (message) =>
        message.kind === "chat" && message.role === "assistant",
    }).length,
    0,
  );
  assert.match(failed.error!, /simulated audit failure/);
});

test("completion, its checkpoint, and result notification are committed together", async (t) => {
  const { broker, store, task } = fixture(t, [
    { type: "text", text: "Finished", cursor: 1 },
    { type: "completed", cursor: 2 },
  ]);
  store.update<Task>("tasks", task.id, {
    eveSessionId: "existing",
    promptDispatch: "sent",
    cursor: 0,
  });
  const originalEvent = store.event.bind(store);
  store.event = (type, data, taskId, sessionId) => {
    if (type === "task.completed")
      throw new Error("simulated completion failure");
    return originalEvent(type, data, taskId, sessionId);
  };
  await broker.runTask(task.id, new AbortController().signal);
  const failed = store.require<Task>("tasks", task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.cursor, 1);
  assert.equal(failed.result, undefined);
  assert.equal(
    store.list<{ kind: string }>("inbox", {
      predicate: (item) => item.kind === "result",
    }).length,
    0,
  );
  assert.equal(
    store.events().some((event) => event.type === "task.completed"),
    false,
  );
});

test("response limit counts UTF-8 bytes and reports a real failure", async (t) => {
  const { broker, store, task } = fixture(t, [
    { type: "text", text: "🐈".repeat(524_289), cursor: 1 },
    { type: "completed", cursor: 2 },
  ]);
  store.update<Task>("tasks", task.id, {
    eveSessionId: "existing",
    promptDispatch: "sent",
    cursor: 0,
  });
  await broker.runTask(task.id, new AbortController().signal);
  const failed = store.require<Task>("tasks", task.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /2 MiB output limit/);
  assert.equal(failed.cursor, 0);
});

test("a dropped transport reconnects to the committed output without dispatching another turn", async (t) => {
  const { broker, store, worker, calls, task } = fixture(t);
  let connection = 0;
  worker.streamWorkerSession = async function* (_sessionId, _taskId, after) {
    calls.streams.push(after ?? 0);
    if (connection++ === 0) {
      yield { type: "text", text: "Saved progress", cursor: 1 };
      throw new Error("connection reset");
    }
    yield { type: "text", text: " and final result", cursor: 2 };
    yield { type: "completed", cursor: 3 };
  };
  await broker.runTask(task.id, new AbortController().signal);
  const reconnecting = store.require<Task>("tasks", task.id);
  assert.equal(reconnecting.status, "queued");
  assert.equal(reconnecting.cursor, 1);
  assert.equal(reconnecting.reconnectAttempts, 1);
  assert.ok(Date.parse(reconnecting.reconnectAfterAt!) > Date.now());
  store.update<Task>("tasks", task.id, {
    reconnectAfterAt: new Date(0).toISOString(),
  });
  await broker.runTask(task.id, new AbortController().signal);
  const completed = store.require<Task>("tasks", task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "Saved progress and final result");
  assert.equal(completed.reconnectAttempts, 0);
  assert.deepEqual(calls.streams, [0, 1]);
  assert.equal(calls.sent.length, 1);
});

test("repeated empty disconnections stop after bounded retries without inventing success", async (t) => {
  const { broker, store, calls, task } = fixture(t);
  for (let attempt = 1; attempt <= 4; attempt++) {
    store.update<Task>("tasks", task.id, {
      reconnectAfterAt: new Date(0).toISOString(),
    });
    await broker.runTask(task.id, new AbortController().signal);
    assert.equal(
      store.require<Task>("tasks", task.id).reconnectAttempts,
      attempt,
    );
  }
  const interrupted = store.require<Task>("tasks", task.id);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.result, undefined);
  assert.match(interrupted.error!, /repeatedly disconnected/);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.created.length, 1);
  assert.equal(
    store.list<{ kind: string }>("inbox", {
      predicate: (item) => item.kind === "result",
    }).length,
    0,
  );
  assert.equal(
    store.list<{ kind: string }>("inbox", {
      predicate: (item) => item.kind === "error",
    }).length,
    1,
  );
});
