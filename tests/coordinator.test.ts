import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Broker, type WorkerClient } from "../src/server/broker";
import { createApp } from "../src/server/api";
import type {
  WorkerEvent,
  WorkerMessageReceipt,
} from "../src/server/eve-worker";
import type { Message, ModelProfile, Session, Task } from "../src/shared/types";

class ControlledWorker implements WorkerClient {
  readonly streams = new Map<string, WorkerEvent[]>();
  readonly gates = new Map<string, Promise<void>>();
  readonly emitted = new Set<string>();
  readonly created: string[] = [];
  readonly dispatched: string[] = [];
  readonly deliveries: {
    sessionId: string;
    taskId: string;
    message: string;
    mode: string;
  }[] = [];
  async workerHealth() {
    return true;
  }
  async createWorkerSession(taskId: string) {
    this.created.push(taskId);
    return randomUUID();
  }
  async sendWorkerMessage(
    sessionId: string,
    taskId: string,
    message: string,
    mode = "queue",
  ): Promise<WorkerMessageReceipt | void> {
    this.dispatched.push(taskId);
    this.deliveries.push({ sessionId, taskId, message, mode });
  }
  async cancelWorkerSession() {}
  async *streamWorkerSession(
    _sessionId: string,
    taskId: string,
    after = 0,
    signal?: AbortSignal,
  ) {
    for (const event of this.streams.get(taskId) ?? []) {
      if (signal?.aborted) return;
      if (event.cursor !== undefined && event.cursor <= after) continue;
      yield event;
    }
    this.emitted.add(taskId);
    const gate = this.gates.get(taskId);
    if (gate) await gate;
    if (!signal?.aborted)
      yield { type: "completed" as const, cursor: Math.max(100, after + 100) };
  }
  pauseAfterText(taskId: string, chunks: string[]) {
    this.streams.set(
      taskId,
      chunks.map((text, index) => ({ type: "text", text, cursor: index + 1 })),
    );
    let release!: () => void;
    this.gates.set(
      taskId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }
}

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Coordinator condition timed out.");
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cit-coordinator-"));
  const worker = new ControlledWorker();
  const broker = new Broker({
    worker,
    config: { dataDir: directory, tickMs: 60_000 },
  });
  const model = broker.store.insert<ModelProfile>("models", {
    name: "Coordinator fixture",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "fixture",
    contextWindow: 8192,
    maxOutputTokens: 2048,
    temperature: 0,
    capabilities: { streaming: true, tools: true },
  });
  broker.updateSettings({ defaultModelProfileId: model.id, maxToolCalls: 100 });
  const main = broker.dotSession("dot-primary");
  const app = createApp({ broker });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await broker.stop();
    await app.close();
    broker.store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const turn = (content = "Coordinate this task.", session: Session = main) =>
    broker.addUserMessage(session.id, { content });
  const tool = (
    taskId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => broker.executeTool({ taskId, callId: randomUUID(), toolName, input });
  const deny = async (
    taskId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => {
    try {
      const result = await tool(taskId, toolName, input);
      assert.match(
        JSON.stringify(result),
        /error|denied|forbidden|coordinator/i,
        "The tool must report a rejected action.",
      );
    } catch (error) {
      assert.match(
        String(error),
        /coordinator|worker|request|message|file|source|completed|Dot|path|symlink|outside|limit|size|session|active/i,
      );
    }
  };
  const delegate = async (parent: Task) => {
    const result = await tool(parent.id, "delegate", {
      role: "coder",
      title: "Implement the requested change",
      prompt: "Produce the requested source file in the workspace.",
    });
    assert.equal(typeof result.childTaskId, "string");
    return broker.store.require<Task>("tasks", String(result.childTaskId));
  };
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url}/api/local${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(json)}`);
    return json as T;
  };
  return {
    directory,
    worker,
    broker,
    model,
    main,
    app,
    url,
    turn,
    tool,
    deny,
    delegate,
    api,
  };
}

test("the canonical Dot coordinator delegates filesystem work and cannot obtain command approval itself", async (t) => {
  const f = await fixture(t);
  const { task } = f.turn("Ask a coder to create a useful source file.");
  assert.equal(task.role, "coordinator");
  for (const [name, input] of [
    ["list_files", {}],
    ["read_file", { path: "main.py" }],
    [
      "write_file",
      { path: "main.py", content: "print('parent authored code')" },
    ],
    ["run_command", { command: "touch parent-ran-command" }],
    ["run_command", { command: "curl https://example.invalid", network: true }],
  ] as const)
    await f.deny(task.id, name, input);
  assert.equal(
    f.broker.store.list("approvals").length,
    0,
    "Coordinator rejection must happen before creating an external-action approval.",
  );
  assert.equal(
    f.broker.store.require<Task>("tasks", task.id).workspace,
    undefined,
  );
  assert.throws(
    () =>
      f.broker.createTask({
        sessionId: f.main.id,
        role: "coder",
        prompt: "Bypass coordination.",
      }),
    /coordinator|canonical|Dot|worker/i,
  );
  const child = await f.delegate(task);
  const written = await f.tool(child.id, "write_file", {
    path: "main.py",
    content: "print('created by coder')\n",
  });
  assert.doesNotMatch(JSON.stringify(written), /"error"/);
  assert.equal(
    await readFile(join(child.workspace!.root, "main.py"), "utf8"),
    "print('created by coder')\n",
  );
  assert.notEqual(child.sessionId, f.main.id);
  assert.equal(child.parentId, task.id);
  const workerSession = f.broker.store.require<Session>(
    "sessions",
    child.sessionId,
  );
  assert.equal(workerSession.kind, "work");
  assert.equal(workerSession.parentTaskId, task.id);
});

test("Dot responses are checked before publication and code cannot leak through streaming or the snapshot", async (t) => {
  const f = await fixture(t);
  const { task } = f.turn("Tell me how the coding task went.");
  const release = f.worker.pauseAfterText(task.id, [
    "Here is the implementation.\n`",
    "``python\ndef leaked_parent_code():\n",
    "    return 'secret-source'\n```\n",
  ]);
  const run = f.broker.runTask(task.id, new AbortController().signal);
  await eventually(() => f.worker.emitted.has(task.id));
  assert.equal(
    f.broker.store
      .messages<Message>(f.main.id)
      .filter((message) => message.role === "assistant").length,
    0,
    "No unchecked partial parent response may enter the main conversation.",
  );
  assert.doesNotMatch(
    JSON.stringify(await f.broker.snapshot()),
    /leaked_parent_code|secret-source/,
  );
  for (const path of [`/sessions/${f.main.id}`, `/tasks/${task.id}`]) {
    const response = await fetch(`${f.url}/api/local${path}`);
    assert.equal(response.status, 200);
    assert.doesNotMatch(
      await response.text(),
      /pendingOutput|leaked_parent_code|secret-source/,
    );
  }
  release();
  await run;
  const published = f.broker.store
    .messages<Message>(f.main.id)
    .filter((message) => message.role === "assistant");
  assert.equal(published.length, 1);
  assert.ok(published[0].content.trim());
  assert.doesNotMatch(
    published[0].content,
    /```|leaked_parent_code|secret-source/,
  );
  assert.doesNotMatch(
    f.broker.store.require<Task>("tasks", task.id).result ?? "",
    /leaked_parent_code|secret-source/,
  );
});

test("public task and session responses keep buffered Dot output private when answering a question or canceling", async (t) => {
  const f = await fixture(t);
  const { task } = f.turn("Coordinate a task that may need my answer.");
  f.broker.store.update<Task>("tasks", task.id, {
    pendingOutput: "```python\nprint('private-buffer-only-marker')\n```",
  });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${f.url}/api/local${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as Record<string, unknown>;
    assert.doesNotMatch(
      JSON.stringify(json),
      /pendingOutput|private-buffer-only-marker/,
    );
    return json;
  };
  await request(`/sessions/${f.main.id}`);
  await request(`/tasks/${task.id}`);
  await f.tool(task.id, "ask_user", {
    question: "Which branch should my worker use?",
  });
  const answered = await request(`/sessions/${f.main.id}/messages`, {
    content: "Use feature/local-coordinator.",
  });
  assert.equal((answered.task as Task).id, task.id);
  const canceled = await request(`/tasks/${task.id}/cancel`, {});
  assert.equal(canceled.id, task.id);
  assert.equal(canceled.status, "canceled");
});

test("completed coder source stays in its worker session while Dot notifications contain conversational text", async (t) => {
  const f = await fixture(t);
  const { task: parent } = f.turn("Have a coder implement the change.");
  const child = await f.delegate(parent);
  const code =
    "```javascript\nexport const child_source_marker = () => 42;\n```";
  f.worker.streams.set(child.id, [{ type: "text", text: code, cursor: 1 }]);
  await f.tool(child.id, "report_progress", {
    message:
      "Implemented `child_source_marker`.\n```javascript\nexport const child_progress_marker = 42;\n```",
  });
  await f.broker.runTask(child.id, new AbortController().signal);
  assert.equal(f.broker.store.require<Task>("tasks", child.id).result, code);
  assert.ok(
    f.broker.store
      .messages<Message>(child.sessionId)
      .some((message) => message.content === code),
  );
  const mainMessages = f.broker.store
    .messages<Message>(f.main.id)
    .filter((message) => message.role === "assistant");
  assert.ok(
    mainMessages.length > 0,
    "Material worker progress is still delivered to the Dot conversation.",
  );
  assert.doesNotMatch(
    JSON.stringify(mainMessages),
    /```|child_source_marker|child_progress_marker/,
  );
  assert.doesNotMatch(
    JSON.stringify(f.broker.store.list("inbox")),
    /```|child_source_marker|child_progress_marker/,
  );
  assert.ok(
    mainMessages.every((message) => !message.files?.length),
    "Completion must not send files without a user request.",
  );
});

test("recognizable unfenced source and patches are withheld from the Dot's final answer", async (t) => {
  const f = await fixture(t);
  for (const source of [
    "print('unfenced-output-marker')",
    "console.log('unfenced-output-marker')",
    "SELECT unfenced_output_marker FROM users;",
    "diff --git a/main.py b/main.py\n--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n+print('unfenced-output-marker')",
  ]) {
    const { task } = f.turn("Summarize the completed coding task in words.");
    f.worker.streams.set(task.id, [{ type: "text", text: source, cursor: 1 }]);
    await f.broker.runTask(task.id, new AbortController().signal);
    const answer = f.broker.store
      .messages<Message>(f.main.id)
      .find(
        (message) => message.role === "assistant" && message.taskId === task.id,
      );
    assert.ok(answer);
    assert.ok(answer.content.trim());
    assert.doesNotMatch(
      answer.content,
      /unfenced[-_]output[-_]marker|diff --git/,
    );
  }
});

test("independent Chat and Work retain their code responses and streaming behavior", async (t) => {
  const f = await fixture(t);
  for (const kind of ["chat", "work"] as const) {
    const session = f.broker.createSession({
      kind,
      dotId: null,
      title: `Independent ${kind}`,
      modelProfileId: f.model.id,
    });
    const { task } = f.turn("Show source code.", session);
    const code = "```python\nprint('standalone-source')\n```";
    const release = f.worker.pauseAfterText(task.id, [code]);
    const run = f.broker.runTask(task.id, new AbortController().signal);
    await eventually(() => f.worker.emitted.has(task.id));
    assert.equal(
      f.broker.store
        .messages<Message>(session.id)
        .find((message) => message.role === "assistant")?.content,
      code,
    );
    release();
    await run;
    assert.equal(f.broker.store.require<Task>("tasks", task.id).result, code);
  }
});

test("a buffered Dot response resumes from its durable cursor without publishing partial text or resending the prompt", async (t) => {
  const f = await fixture(t);
  const { task } = f.turn("Summarize the worker's progress.");
  const release = f.worker.pauseAfterText(task.id, [
    "I asked",
    " a coding worker",
  ]);
  const controller = new AbortController();
  const run = f.broker.runTask(task.id, controller.signal);
  await eventually(() => f.worker.emitted.has(task.id));
  assert.equal(f.broker.store.require<Task>("tasks", task.id).cursor, 2);
  assert.equal(
    f.broker.store
      .messages<Message>(f.main.id)
      .filter((message) => message.role === "assistant").length,
    0,
  );
  controller.abort();
  release();
  await run;
  f.broker.updateSettings({ paused: true });
  f.worker.streams.set(task.id, [
    { type: "text", text: "DUPLICATE-MUST-NOT-APPEAR", cursor: 2 },
    { type: "text", text: ". The task passed its checks.", cursor: 3 },
  ]);
  const restarted = new Broker({
    worker: f.worker,
    config: { dataDir: f.directory, tickMs: 60_000 },
  });
  try {
    await restarted.start();
    await restarted.runTask(task.id, new AbortController().signal);
    assert.equal(
      restarted.store.require<Task>("tasks", task.id).result,
      "I asked a coding worker. The task passed its checks.",
    );
    assert.equal(
      restarted.store
        .messages<Message>(f.main.id)
        .filter((message) => message.role === "assistant").length,
      1,
    );
    assert.deepEqual(f.worker.created, [task.id]);
    assert.deepEqual(f.worker.dispatched, [task.id]);
  } finally {
    await restarted.stop();
    restarted.store.close();
  }
});

test("a requested worker file is forwarded as a byte-accurate immutable download without putting source in the Dot conversation", async (t) => {
  const f = await fixture(t);
  const { task: previous } = f.turn("Have a worker produce my file.");
  const source = await f.delegate(previous);
  const bytes = Buffer.from(
    "export const forwarded_file_marker = 'original';\n\0binary-tail",
    "utf8",
  );
  await writeFile(join(source.workspace!.root, "result.mjs"), bytes);
  await f.broker.runTask(source.id, new AbortController().signal);
  const requested = f.turn(
    "Please send me the file the coding worker produced.",
  );
  const forwarded = await f.tool(requested.task.id, "forward_file", {
    sourceTaskId: source.id,
    path: "result.mjs",
    requestMessageId: requested.message.id,
  });
  const receipt = forwarded.result as {
    file: { id: string; name: string; size: number; sourceTaskId: string };
    messageId: string;
  };
  assert.equal(receipt.file.name, "result.mjs");
  assert.equal(receipt.file.size, bytes.length);
  assert.equal(receipt.file.sourceTaskId, source.id);
  const message = f.broker.store.require<Message>(
    "messages",
    receipt.messageId,
  );
  assert.equal(message.sessionId, f.main.id);
  assert.equal(message.taskId, requested.task.id);
  assert.deepEqual(message.files, [receipt.file]);
  assert.doesNotMatch(
    message.content,
    /forwarded_file_marker|original|binary-tail/,
  );
  await writeFile(
    join(source.workspace!.root, "result.mjs"),
    "Changed after sending.\n",
  );
  const downloaded = await fetch(`${f.url}/api/local/files/${receipt.file.id}`);
  assert.equal(downloaded.status, 200);
  assert.match(
    downloaded.headers.get("content-disposition") ?? "",
    /attachment.*result\.mjs/,
  );
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const transcript = f.broker.store
    .messages<Message>(f.main.id)
    .filter((item) => item.role === "assistant");
  assert.doesNotMatch(
    JSON.stringify(transcript),
    /forwarded_file_marker|binary-tail/,
  );
  assert.doesNotMatch(
    JSON.stringify(await f.broker.snapshot()),
    new RegExp(bytes.toString("base64")),
  );
});

test("file forwarding requires the current Dot coordinator's actual user request and a completed worker belonging to that Dot", async (t) => {
  const f = await fixture(t);
  const older = f.turn("Produce a file.");
  const source = await f.delegate(older.task);
  await f.tool(source.id, "write_file", {
    path: "result.txt",
    content: "owned result",
  });
  const requested = f.turn("Please send the result file.");
  const input = {
    sourceTaskId: source.id,
    path: "result.txt",
    requestMessageId: requested.message.id,
  };
  await f.deny(requested.task.id, "forward_file", input);
  await f.broker.runTask(source.id, new AbortController().signal);
  await f.deny(requested.task.id, "forward_file", {
    ...input,
    requestMessageId: older.message.id,
  });
  await f.deny(requested.task.id, "forward_file", {
    ...input,
    requestMessageId: "missing-user-message",
  });
  const assistant = f.broker.store.addMessage<Message>(f.main.id, {
    role: "assistant",
    taskId: requested.task.id,
    content: "A message from the assistant.",
  });
  await f.deny(requested.task.id, "forward_file", {
    ...input,
    requestMessageId: assistant.id,
  });
  const wrongSession = f.broker.createSession({
    kind: "dot",
    dotId: "dot-primary",
    title: "Worker private session",
    modelProfileId: f.model.id,
  });
  const elsewhere = f.broker.store.addMessage<Message>(wrongSession.id, {
    role: "user",
    taskId: requested.task.id,
    content: "Send the file from another session.",
  });
  await f.deny(requested.task.id, "forward_file", {
    ...input,
    requestMessageId: elsewhere.id,
  });
  await f.deny(source.id, "forward_file", input);
  await f.deny(requested.task.id, "forward_file", {
    ...input,
    sourceTaskId: older.task.id,
  });
  const other = f.broker.createDot({
    name: "Other Dot",
    modelProfileId: f.model.id,
  });
  const otherTurn = f.turn(
    "Create another Dot's file.",
    f.broker.dotSession(other.id),
  );
  const otherChild = await f.delegate(otherTurn.task);
  await f.tool(otherChild.id, "write_file", {
    path: "result.txt",
    content: "another Dot's private result",
  });
  await f.broker.runTask(otherChild.id, new AbortController().signal);
  await f.deny(requested.task.id, "forward_file", {
    ...input,
    sourceTaskId: otherChild.id,
  });
  const independentSession = f.broker.createSession({
    kind: "chat",
    dotId: null,
    title: "Independent",
    modelProfileId: f.model.id,
  });
  const independent = f.turn("Send a Dot-owned file.", independentSession);
  await f.deny(independent.task.id, "forward_file", {
    ...input,
    requestMessageId: independent.message.id,
  });
  assert.equal(
    f.broker.store.list("attachments").length,
    0,
    "Rejected requests must not create transferable files.",
  );
});

test("forwarded files cannot escape the completed worker workspace through paths or symlinks", async (t) => {
  const f = await fixture(t);
  const previous = f.turn("Make a file to send later.");
  const source = await f.delegate(previous.task);
  await f.tool(source.id, "write_file", {
    path: "result.txt",
    content: "worker result",
  });
  const outside = join(f.directory, "outside-private.txt");
  await writeFile(outside, "outside-private-marker");
  await symlink(outside, join(source.workspace!.root, "linked.txt"));
  await f.broker.runTask(source.id, new AbortController().signal);
  const requested = f.turn("Send me the file the worker made.");
  for (const path of ["../outside-private.txt", outside, "linked.txt", "."]) {
    await f.deny(requested.task.id, "forward_file", {
      sourceTaskId: source.id,
      path,
      requestMessageId: requested.message.id,
    });
  }
  assert.equal(f.broker.store.list("attachments").length, 0);
  assert.doesNotMatch(
    JSON.stringify(f.broker.store.messages<Message>(f.main.id)),
    /outside-private-marker/,
  );
  const unknown = await fetch(`${f.url}/api/local/files/unknown-file`);
  assert.notEqual(unknown.status, 200);
});

test("file forwarding is bounded and replaying an existing delivery does not send another file", async (t) => {
  const f = await fixture(t);
  const previous = f.turn("Make files for a later request.");
  const source = await f.delegate(previous.task);
  await f.tool(source.id, "write_file", {
    path: "result.txt",
    content: "a requested result",
  });
  const oversized = join(source.workspace!.root, "oversized.bin");
  await writeFile(oversized, "");
  await truncate(oversized, 8 * 1024 * 1024 + 1);
  await f.broker.runTask(source.id, new AbortController().signal);
  const requested = f.turn("Send me the worker's result files.");
  const input = {
    sourceTaskId: source.id,
    path: "result.txt",
    requestMessageId: requested.message.id,
  };
  await f.deny(requested.task.id, "forward_file", {
    ...input,
    path: "oversized.bin",
  });
  const action = {
    taskId: requested.task.id,
    callId: "one-delivery",
    toolName: "forward_file",
    input,
  };
  const initial = await f.broker.executeTool(action);
  const replay = await f.broker.executeTool(action);
  assert.deepEqual(replay, initial);
  assert.equal(f.broker.store.list("attachments").length, 1);
  for (let index = 1; index < 5; index++) {
    const result = await f.tool(requested.task.id, "forward_file", input);
    assert.doesNotMatch(JSON.stringify(result), /"error"/);
  }
  await f.deny(requested.task.id, "forward_file", input);
  assert.equal(f.broker.store.list("attachments").length, 5);
  assert.equal(
    f.broker.store
      .messages<Message>(f.main.id)
      .filter((message) => message.files?.length).length,
    5,
  );
});

test("a Dot can launch an asynchronous worker and is awakened once to review its completed result", async (t) => {
  const f = await fixture(t);
  const { task: parent } = f.turn(
    "Begin coding and keep me informed when there is progress.",
  );
  const started = await f.tool(parent.id, "delegate", {
    role: "coder",
    prompt: "Build the requested feature.",
    wait: false,
  });
  const child = f.broker.store.require<Task>(
    "tasks",
    String(started.childTaskId),
  );
  assert.notEqual(
    f.broker.store.require<Task>("tasks", parent.id).status,
    "waiting_child",
  );
  f.worker.streams.set(parent.id, [
    {
      type: "text",
      text: "I started a coding worker and will follow up when it has a result.",
      cursor: 1,
    },
  ]);
  await f.broker.runTask(parent.id, new AbortController().signal);
  assert.equal(
    f.broker.store.require<Task>("tasks", parent.id).status,
    "completed",
  );
  f.worker.streams.set(child.id, [
    {
      type: "text",
      text: "The implementation passed its project checks.",
      cursor: 1,
    },
  ]);
  await f.broker.runTask(child.id, new AbortController().signal);
  const reviews = f.broker.store.list<Task>("tasks", {
    predicate: (task) => task.triggeredByWorkerId === child.id,
  });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].role, "coordinator");
  assert.equal(reviews[0].sessionId, f.main.id);
  assert.match(reviews[0].prompt, /task_status|evidence/);
  await f.broker.runTask(child.id, new AbortController().signal);
  assert.equal(
    f.broker.store.list<Task>("tasks", {
      predicate: (task) => task.triggeredByWorkerId === child.id,
    }).length,
    1,
  );
  const status = await f.tool(reviews[0].id, "task_status", {
    workerTaskId: child.id,
  });
  assert.equal((status.result as { status: string }).status, "completed");
});

test("steering and queued follow-ups reuse the same worker and its existing conversation", async (t) => {
  const f = await fixture(t);
  const initial = f.turn("Start a worker for my project.");
  const source = await f.delegate(initial.task);
  const manage = f.turn(
    "Adjust the worker's approach, then ask for the next step.",
  );
  await f.tool(manage.task.id, "send_worker_message", {
    workerTaskId: source.id,
    mode: "steer",
    message: "Use the existing module structure.",
  });
  await f.tool(manage.task.id, "send_worker_message", {
    workerTaskId: source.id,
    mode: "queue",
    message: "Review the test coverage next.",
  });
  assert.match(
    f.broker.store.require<Task>("tasks", source.id).prompt,
    /Steering instruction: Use the existing module structure/,
  );
  assert.match(
    f.broker.store.require<Task>("tasks", source.id).prompt,
    /Queued follow-up: Review the test coverage next/,
  );
  assert.equal(
    f.worker.dispatched.length,
    0,
    "Follow-ups before initial dispatch become part of that bounded first prompt.",
  );
  f.worker.streams.set(source.id, [
    { type: "text", text: "The first requested step is complete.", cursor: 1 },
  ]);
  await f.broker.runTask(source.id, new AbortController().signal);
  const sessionId = f.broker.store.require<Task>(
    "tasks",
    source.id,
  ).eveSessionId!;
  const more = f.turn("Have the same worker continue with the next change.");
  const reply = await f.tool(more.task.id, "send_worker_message", {
    workerTaskId: source.id,
    mode: "queue",
    message: "Continue the next change in this same session.",
  });
  assert.equal(
    (reply.result as { childTaskId: string }).childTaskId,
    source.id,
  );
  assert.equal(
    f.broker.store.require<Task>("tasks", source.id).status,
    "queued",
  );
  f.worker.streams.set(source.id, [
    { type: "text", text: "The next change is complete.", cursor: 101 },
  ]);
  await f.broker.runTask(source.id, new AbortController().signal);
  assert.equal(
    f.broker.store.require<Task>("tasks", source.id).result,
    "The next change is complete.",
  );
  assert.equal(
    f.broker.store.require<Task>("tasks", source.id).eveSessionId,
    sessionId,
  );
  assert.deepEqual(f.worker.created, [source.id]);
  assert.equal(f.worker.deliveries.at(-1)?.sessionId, sessionId);
  assert.equal(f.worker.deliveries.at(-1)?.mode, "queue");
  assert.ok(
    f.broker.store
      .messages<Message>(source.sessionId)
      .some(
        (message) =>
          message.content === "Continue the next change in this same session.",
      ),
  );
  assert.equal(
    f.broker.store.list<Task>("tasks", {
      predicate: (task) =>
        task.triggeredByWorkerId === source.id &&
        task.triggeredByWorkerCursor === 200,
    }).length,
    1,
    "A continued worker that was originally launched synchronously must wake the Dot to review its later result.",
  );
});

test("an earlier worker completion cannot finish a task that still has a queued delivery", async (t) => {
  const f = await fixture(t);
  const parent = f.turn("Start a worker and queue another instruction.");
  const source = await f.delegate(parent.task);
  f.broker.store.update<Task>("tasks", source.id, {
    status: "running",
    eveSessionId: "existing-worker",
    promptDispatch: "sent",
    cursor: 0,
  });
  f.worker.sendWorkerMessage = async () => ({
    deliveryId: "queued-second-prompt",
  });
  await f.tool(parent.task.id, "send_worker_message", {
    workerTaskId: source.id,
    mode: "queue",
    message: "Perform the second step after the first.",
  });
  f.worker.streams.set(source.id, [
    { type: "text", text: "The first step is done. ", cursor: 1 },
    { type: "completed", cursor: 2, deliveryIds: ["initial-prompt"] },
  ]);
  await f.broker.runTask(source.id, new AbortController().signal);
  const pending = f.broker.store.require<Task>("tasks", source.id);
  assert.equal(pending.status, "queued");
  assert.deepEqual(pending.pendingDeliveryIds, ["queued-second-prompt"]);
  assert.equal(pending.result, undefined);
  assert.ok(
    !f.broker.store
      .list<{ taskId: string; kind: string }>("inbox")
      .some((item) => item.taskId === source.id && item.kind === "result"),
  );
  f.worker.streams.set(source.id, [
    { type: "text", text: "The queued second step is done.", cursor: 3 },
    { type: "completed", cursor: 4, deliveryIds: ["queued-second-prompt"] },
  ]);
  await f.broker.runTask(source.id, new AbortController().signal);
  const completed = f.broker.store.require<Task>("tasks", source.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.pendingDeliveryIds, []);
  assert.equal(completed.result, "The queued second step is done.");
  assert.equal(completed.cursor, 4);
});

test("a fast worker completion arriving before the send receipt is finalized once that exact delivery is confirmed", async (t) => {
  const f = await fixture(t);
  const parent = f.turn("Queue one more instruction for the worker.");
  const source = await f.delegate(parent.task);
  f.broker.store.update<Task>("tasks", source.id, {
    status: "running",
    eveSessionId: "fast-worker",
    promptDispatch: "sent",
    cursor: 0,
  });
  let accept!: (receipt: WorkerMessageReceipt) => void;
  let announce!: () => void;
  const sending = new Promise<void>((resolve) => {
    announce = resolve;
  });
  f.worker.sendWorkerMessage = () => {
    announce();
    return new Promise<WorkerMessageReceipt>((resolve) => {
      accept = resolve;
    });
  };
  const followUp = f.tool(parent.task.id, "send_worker_message", {
    workerTaskId: source.id,
    mode: "steer",
    message: "Use the updated requirement.",
  });
  await sending;
  f.worker.streams.set(source.id, [
    {
      type: "text",
      text: "The updated requirement is implemented.",
      cursor: 1,
    },
    { type: "completed", cursor: 2, deliveryIds: ["fast-delivery"] },
  ]);
  await f.broker.runTask(source.id, new AbortController().signal);
  const unconfirmed = f.broker.store.require<Task>("tasks", source.id);
  assert.equal(unconfirmed.status, "queued");
  assert.ok(unconfirmed.pendingSend);
  assert.equal(unconfirmed.result, undefined);
  accept({ deliveryId: "fast-delivery" });
  await followUp;
  const confirmed = f.broker.store.require<Task>("tasks", source.id);
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.result, "The updated requirement is implemented.");
  assert.equal(confirmed.pendingSend, undefined);
  assert.equal(confirmed.deferredCompletion, undefined);
  assert.deepEqual(confirmed.pendingDeliveryIds, []);
  assert.equal(
    f.broker.store
      .list<{ taskId: string; kind: string }>("inbox")
      .filter((item) => item.taskId === source.id && item.kind === "result")
      .length,
    1,
  );
});

test("restart interrupts an uncertain worker follow-up instead of dispatching it again", async (t) => {
  const f = await fixture(t);
  const parent = f.turn("Continue a worker's task.");
  const source = await f.delegate(parent.task);
  f.broker.store.update<Task>("tasks", source.id, {
    status: "running",
    eveSessionId: "uncertain-follow-up",
    promptDispatch: "sent",
    pendingSend: "unconfirmed-operation",
  });
  f.broker.updateSettings({ paused: true });
  await f.broker.start();
  const recovered = f.broker.store.require<Task>("tasks", source.id);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.eveSessionId, "uncertain-follow-up");
  assert.equal(recovered.pendingSend, undefined);
  assert.match(recovered.error ?? "", /follow-up|uncertain delivery/i);
  assert.deepEqual(f.worker.created, []);
  assert.deepEqual(f.worker.dispatched, []);
});

test("retrying a stopped Dot worker creates a managed coordinator turn while retaining its workspace", async (t) => {
  const f = await fixture(t);
  const original = f.turn("Create a project result.");
  const source = await f.delegate(original.task);
  await f.tool(source.id, "write_file", {
    path: "retained.txt",
    content: "Reviewable work before interruption.",
  });
  await f.broker.cancelTask(source.id);
  const retry = await f.api<Task>(`/tasks/${source.id}/retry`, {});
  assert.equal(retry.role, "coordinator");
  assert.equal(retry.dotId, "dot-primary");
  assert.equal(retry.sessionId, f.main.id);
  assert.equal(retry.parentId, null);
  assert.notEqual(retry.id, source.id);
  assert.equal(retry.workspace?.root, source.workspace!.root);
  const replacement = await f.delegate(retry);
  assert.equal(replacement.parentId, retry.id);
  assert.equal(replacement.workspace?.root, source.workspace!.root);
  assert.equal(
    f.broker.store.require<Session>("sessions", replacement.sessionId)
      .parentTaskId,
    retry.id,
  );
  assert.equal(
    await readFile(join(replacement.workspace!.root, "retained.txt"), "utf8"),
    "Reviewable work before interruption.",
  );
  const independentSession = f.broker.createSession({
    kind: "work",
    dotId: null,
    title: "Independent retry",
    modelProfileId: f.model.id,
  });
  const independent = f.turn("Retry ordinary coding.", independentSession);
  await f.broker.cancelTask(independent.task.id);
  const independentRetry = await f.api<Task>(
    `/tasks/${independent.task.id}/retry`,
    {},
  );
  assert.equal(independentRetry.dotId, null);
  assert.equal(independentRetry.role, "coder");
  assert.equal(independentRetry.sessionId, independentSession.id);
});

test("a direct worker-session message creates a coordinator that queues the same existing worker conversation", async (t) => {
  const f = await fixture(t);
  const original = f.turn("Start a worker for the project.");
  const source = await f.delegate(original.task);
  f.worker.streams.set(source.id, [
    { type: "text", text: "The first project change is done.", cursor: 1 },
  ]);
  await f.broker.runTask(source.id, new AbortController().signal);
  const existing = f.broker.store.require<Task>("tasks", source.id);
  const response = await f.api<{ task: Task; message: Message }>(
    `/sessions/${source.sessionId}/messages`,
    { content: "Continue with the next project change in this session." },
  );
  assert.equal(response.task.role, "coordinator");
  assert.equal(response.task.sessionId, f.main.id);
  assert.equal(response.task.parentId, null);
  assert.notEqual(response.task.id, source.id);
  assert.equal(response.message.sessionId, f.main.id);
  assert.equal(response.message.taskId, response.task.id);
  assert.equal(f.worker.deliveries.at(-1)?.sessionId, existing.eveSessionId);
  assert.equal(f.worker.deliveries.at(-1)?.taskId, source.id);
  assert.equal(f.worker.deliveries.at(-1)?.mode, "queue");
  assert.equal(f.worker.deliveries.at(-1)?.message, response.message.content);
  assert.equal(
    f.broker.store.require<Task>("tasks", source.id).latestRequestTaskId,
    response.task.id,
  );
  f.worker.streams.set(source.id, [
    { type: "text", text: "The continued change is done.", cursor: 101 },
  ]);
  await f.broker.runTask(source.id, new AbortController().signal);
  assert.equal(
    f.broker.store.require<Task>("tasks", source.id).eveSessionId,
    existing.eveSessionId,
  );
  assert.equal(
    f.broker.store.require<Task>("tasks", source.id).sessionId,
    source.sessionId,
  );
  assert.deepEqual(f.worker.created, [source.id]);
  for (const kind of ["chat", "work"] as const) {
    const standalone = f.broker.createSession({
      kind,
      dotId: null,
      title: `Independent ${kind}`,
      modelProfileId: f.model.id,
    });
    const turn = await f.api<{ task: Task; message: Message }>(
      `/sessions/${standalone.id}/messages`,
      { content: "An ordinary independent prompt." },
    );
    assert.equal(turn.task.dotId, null);
    assert.equal(turn.task.role, kind === "work" ? "coder" : "coordinator");
    assert.equal(turn.task.sessionId, standalone.id);
    assert.equal(turn.message.sessionId, standalone.id);
  }
});

test("a requested asynchronous file can be delivered on completion using only that worker's originating user request", async (t) => {
  const f = await fixture(t);
  const unrelated = f.turn("An older, unrelated file request.");
  const requested = f.turn(
    "Create a source file and send it to me when it is ready.",
  );
  const started = await f.tool(requested.task.id, "delegate", {
    role: "coder",
    prompt: "Create the requested source file.",
    wait: false,
  });
  const source = f.broker.store.require<Task>(
    "tasks",
    String(started.childTaskId),
  );
  assert.equal(source.latestRequestTaskId, requested.task.id);
  await f.tool(source.id, "write_file", {
    path: "requested.py",
    content: "print('requested-asynchronous-file')\n",
  });
  await f.broker.runTask(source.id, new AbortController().signal);
  const review = f.broker.store.list<Task>("tasks", {
    predicate: (task) => task.triggeredByWorkerId === source.id,
  })[0];
  assert.ok(review);
  const context = f.broker.workerContext(review.id);
  assert.deepEqual(context.userMessages, [
    { id: requested.message.id, content: requested.message.content },
  ]);
  await f.deny(review.id, "forward_file", {
    sourceTaskId: source.id,
    path: "requested.py",
    requestMessageId: unrelated.message.id,
  });
  const other = f.broker.createDot({
    name: "Other request owner",
    modelProfileId: f.model.id,
  });
  const otherRequest = f.turn(
    "Send another Dot's source file.",
    f.broker.dotSession(other.id),
  );
  await f.deny(review.id, "forward_file", {
    sourceTaskId: source.id,
    path: "requested.py",
    requestMessageId: otherRequest.message.id,
  });
  const differentRequest = f.turn("Create a different file for another task.");
  const differentSource = await f.delegate(differentRequest.task);
  await f.tool(differentSource.id, "write_file", {
    path: "different.py",
    content: "Another worker's output.",
  });
  await f.broker.runTask(differentSource.id, new AbortController().signal);
  await f.deny(review.id, "forward_file", {
    sourceTaskId: differentSource.id,
    path: "different.py",
    requestMessageId: requested.message.id,
  });
  const forwarded = await f.tool(review.id, "forward_file", {
    sourceTaskId: source.id,
    path: "requested.py",
    requestMessageId: requested.message.id,
  });
  const file = (forwarded.result as { file: { id: string } }).file;
  const response = await fetch(`${f.url}/api/local/files/${file.id}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "print('requested-asynchronous-file')\n");
  assert.doesNotMatch(
    JSON.stringify(
      f.broker.store
        .messages<Message>(f.main.id)
        .filter((message) => message.role === "assistant"),
    ),
    /requested-asynchronous-file/,
  );
});

test("an accepted follow-up replaces the worker's originating request for its later asynchronous result", async (t) => {
  const f = await fixture(t);
  const original = f.turn("Create and send an initial result file.");
  const source = await f.delegate(original.task);
  await f.tool(source.id, "write_file", {
    path: "result.txt",
    content: "Initial result.",
  });
  await f.broker.runTask(source.id, new AbortController().signal);
  const updated = f.turn(
    "Update the result and send the updated file when ready.",
  );
  await f.tool(updated.task.id, "send_worker_message", {
    workerTaskId: source.id,
    message: "Update the file in the same workspace.",
    mode: "queue",
  });
  assert.equal(
    f.broker.store.require<Task>("tasks", source.id).latestRequestTaskId,
    updated.task.id,
  );
  await f.tool(source.id, "write_file", {
    path: "result.txt",
    content: "Updated result.",
  });
  f.worker.streams.set(source.id, [
    { type: "text", text: "The requested update is ready.", cursor: 101 },
  ]);
  await f.broker.runTask(source.id, new AbortController().signal);
  const review = f.broker.store.list<Task>("tasks", {
    predicate: (task) =>
      task.triggeredByWorkerId === source.id &&
      task.triggeredByWorkerCursor === 200,
  })[0];
  assert.ok(review);
  assert.deepEqual(f.broker.workerContext(review.id).userMessages, [
    { id: updated.message.id, content: updated.message.content },
  ]);
  await f.deny(review.id, "forward_file", {
    sourceTaskId: source.id,
    path: "result.txt",
    requestMessageId: original.message.id,
  });
  const forwarded = await f.tool(review.id, "forward_file", {
    sourceTaskId: source.id,
    path: "result.txt",
    requestMessageId: updated.message.id,
  });
  assert.equal(
    typeof (forwarded.result as { file: { id: string } }).file.id,
    "string",
  );
});

test("requested guest workspace and artifact paths map only to the owning worker's files and preserve binary bytes", async (t) => {
  const f = await fixture(t);
  const original = f.turn("Create binary outputs for a later request.");
  const source = await f.delegate(original.task);
  const workspaceBytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  const artifactBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  await writeFile(
    join(source.workspace!.root, "workspace.bin"),
    workspaceBytes,
  );
  await writeFile(
    join(source.workspace!.computerRoot!, "artifacts", "output.bin"),
    artifactBytes,
  );
  const oversized = join(
    source.workspace!.computerRoot!,
    "artifacts",
    "oversized.bin",
  );
  await writeFile(oversized, "");
  await truncate(oversized, 8 * 1024 * 1024 + 1);
  await f.broker.runTask(source.id, new AbortController().signal);
  const requested = f.turn(
    "Send the binary outputs from the worker's workspace and artifacts directory.",
  );
  for (const [path, expected] of [
    ["/workspace/workspace.bin", workspaceBytes],
    ["/artifacts/output.bin", artifactBytes],
  ] as const) {
    const forwarded = await f.tool(requested.task.id, "forward_file", {
      sourceTaskId: source.id,
      path,
      requestMessageId: requested.message.id,
    });
    const file = (forwarded.result as { file: { id: string; size: number } })
      .file;
    assert.equal(file.size, expected.length);
    const response = await fetch(`${f.url}/api/local/files/${file.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  for (const path of [
    "/artifacts/oversized.bin",
    "/artifacts/../home/private.txt",
    "/workspace/../home/private.txt",
    "/home/cit/private.txt",
  ]) {
    await f.deny(requested.task.id, "forward_file", {
      sourceTaskId: source.id,
      path,
      requestMessageId: requested.message.id,
    });
  }
  const other = f.broker.createDot({
    name: "Other artifact owner",
    modelProfileId: f.model.id,
  });
  const otherTurn = f.turn(
    "Produce another Dot's artifact.",
    f.broker.dotSession(other.id),
  );
  const otherSource = await f.delegate(otherTurn.task);
  const otherArtifact = join(
    otherSource.workspace!.computerRoot!,
    "artifacts",
    "private.bin",
  );
  await writeFile(otherArtifact, "Other Dot's private artifact.");
  await f.broker.runTask(otherSource.id, new AbortController().signal);
  await f.deny(requested.task.id, "forward_file", {
    sourceTaskId: otherSource.id,
    path: "/artifacts/private.bin",
    requestMessageId: requested.message.id,
  });
  await symlink(
    otherArtifact,
    join(source.workspace!.computerRoot!, "artifacts", "linked.bin"),
  );
  await f.deny(requested.task.id, "forward_file", {
    sourceTaskId: source.id,
    path: "/artifacts/linked.bin",
    requestMessageId: requested.message.id,
  });
  assert.equal(f.broker.store.list("attachments").length, 2);
});

test("a direct worker-session answer resolves its existing question without creating a coordinator or queuing another turn", async (t) => {
  const f = await fixture(t);
  const original = f.turn("Have the worker ask which branch to use.");
  const source = await f.delegate(original.task);
  f.broker.store.update<Task>("tasks", source.id, {
    status: "running",
    eveSessionId: "existing-question-session",
    promptDispatch: "sent",
  });
  const question = await f.broker.executeTool({
    taskId: source.id,
    callId: "worker-question",
    toolName: "ask_user",
    input: { question: "Which branch should I use for the project?" },
  });
  assert.ok(question.approval);
  const taskCount = f.broker.store.list<Task>("tasks").length;
  const answer = await f.api<{ task: Task; message: Message }>(
    `/sessions/${source.sessionId}/messages`,
    { content: "Use feature/existing-worker." },
  );
  assert.equal(answer.task.id, source.id);
  assert.equal(answer.task.parentId, original.task.id);
  assert.equal(answer.task.eveSessionId, "existing-question-session");
  assert.equal(answer.message.sessionId, source.sessionId);
  assert.equal(answer.message.taskId, source.id);
  assert.equal(f.broker.store.list<Task>("tasks").length, taskCount);
  assert.deepEqual(f.worker.dispatched, []);
  await eventually(
    () =>
      f.broker.toolResult(source.id, "worker-question").status === "completed",
  );
  const resolved = f.broker.toolResult(source.id, "worker-question");
  assert.equal(
    (resolved.result as { answer: string }).answer,
    "Use feature/existing-worker.",
  );
  assert.ok(
    !f.broker.store
      .list<{ toolName: string }>("tool_operations")
      .some((operation) => operation.toolName === "send_worker_message"),
  );
});

test("empty scheduled checks and worker-result reviews stay quiet while a direct user request receives a completion reply", async (t) => {
  const f = await fixture(t);
  const goal = await f.api<{ id: string }>("/goals", {
    title: "Quiet material-change check",
    objective:
      "Inspect existing state and stay quiet when there is no material change.",
    sessionId: f.main.id,
    modelProfileId: f.model.id,
    scheduleType: "once",
    nextRunAt: "2035-01-01T00:00:00.000Z",
    timezone: "America/New_York",
  });
  const scheduled = f.broker.createTask({
    sessionId: f.main.id,
    goalId: goal.id,
    prompt: "Scheduled check found no material changes.",
  });
  const original = f.turn(
    "Work in the background and tell me only when there is something useful.",
  );
  const started = await f.tool(original.task.id, "delegate", {
    role: "investigator",
    prompt: "Inspect the current state.",
    wait: false,
  });
  const child = f.broker.store.require<Task>(
    "tasks",
    String(started.childTaskId),
  );
  f.worker.streams.set(child.id, [
    {
      type: "text",
      text: "Inspection is complete; no additional user action is required.",
      cursor: 1,
    },
  ]);
  await f.broker.runTask(child.id, new AbortController().signal);
  const review = f.broker.store.list<Task>("tasks", {
    predicate: (task) => task.triggeredByWorkerId === child.id,
  })[0];
  assert.ok(review);
  f.worker.streams.set(review.id, [
    { type: "text", text: "\n \t ", cursor: 1 },
  ]);
  const beforeMessages = f.broker.store.messages<Message>(f.main.id).length;
  const beforeInbox = f.broker.store.list("inbox").length;
  for (const background of [scheduled, review]) {
    await f.broker.runTask(background.id, new AbortController().signal);
    const completed = f.broker.store.require<Task>("tasks", background.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.trim(), "");
    assert.ok(
      !f.broker.store
        .messages<Message>(f.main.id)
        .some(
          (message) =>
            message.role === "assistant" && message.taskId === background.id,
        ),
    );
    assert.ok(
      !f.broker.store
        .list<{ taskId?: string }>("inbox")
        .some((item) => item.taskId === background.id),
    );
  }
  assert.equal(
    f.broker.store.messages<Message>(f.main.id).length,
    beforeMessages,
  );
  assert.equal(f.broker.store.list("inbox").length, beforeInbox);
  const requested = f.turn("Acknowledge when this request has finished.");
  await f.broker.runTask(requested.task.id, new AbortController().signal);
  const answer = f.broker.store
    .messages<Message>(f.main.id)
    .find(
      (message) =>
        message.role === "assistant" && message.taskId === requested.task.id,
    );
  assert.equal(answer?.content, "Task completed.");
});
