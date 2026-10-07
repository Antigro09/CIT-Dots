import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Broker } from "../src/server/broker";
import { createApp } from "../src/server/api";
import type {
  Task,
  ModelProfile,
  Project,
  Session,
  Approval,
  Snapshot,
  ToolOperation,
} from "../src/shared/types";
import {
  createFakeModel,
  type CompletionRequest,
  type ChatMessage,
} from "./fake-model";

const exec = promisify(execFile);
const token = "integration-only-token";
const tools = [
  "list_files",
  "read_file",
  "write_file",
  "run_command",
  "delegate",
  "report_progress",
  "remember",
  "ask_user",
];

/**
 * A deterministic workflow driver, replacing only Eve's workflow process. It talks
 * to the real broker's authenticated context, model proxy, tools, and polling APIs.
 * Real-Eve validation is run separately against the same fake-model HTTP server.
 */
class FixtureWorker {
  url = "";
  readonly canceled = new Set<string>();
  readonly sessions = new Map<string, string>();
  readonly prompts = new Map<string, string>();
  private async internal(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await fetch(`${this.url}/api/internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(
        `Worker HTTP ${response.status}: ${await response.text()}`,
      );
    return response.json() as Promise<Record<string, any>>;
  }
  async createWorkerSession(taskId: string) {
    const id = randomUUID();
    this.sessions.set(id, taskId);
    return id;
  }
  async sendWorkerMessage(sessionId: string, _taskId: string, message: string) {
    this.prompts.set(sessionId, message);
  }
  async cancelWorkerSession(sessionId: string) {
    this.canceled.add(sessionId);
  }
  async workerHealth() {
    return true;
  }
  async *streamWorkerSession(
    sessionId: string,
    taskId: string,
    _after?: number,
    signal?: AbortSignal,
  ) {
    try {
      const context = await this.internal(
        `/worker-context?taskId=${encodeURIComponent(taskId)}`,
        undefined,
        signal,
      );
      const messages: ChatMessage[] = [
        { role: "system", content: context.instructions },
        ...context.messages,
      ];
      const prompt = this.prompts.get(sessionId);
      if (prompt && messages.at(-1)?.content !== prompt)
        messages.push({ role: "user", content: prompt });
      let cursor = 0;
      for (let step = 0; step < 40 && !this.canceled.has(sessionId); step++) {
        if (signal?.aborted) return;
        const answer = await this.internal(
          `/model/${taskId}/v1/chat/completions`,
          {
            model: context.model.modelId,
            messages,
            stream: false,
            tools: tools.map((name) => ({
              type: "function",
              function: {
                name,
                parameters: { type: "object", additionalProperties: true },
              },
            })),
          },
          signal,
        );
        const choice = answer.choices[0];
        const message = choice.message as ChatMessage;
        messages.push(message);
        if (!message.tool_calls?.length) {
          const text = String(message.content ?? "");
          for (const chunk of text.match(/.{1,11}/gs) ?? [])
            yield { type: "text" as const, text: chunk, cursor: ++cursor };
          yield { type: "completed" as const, cursor: ++cursor };
          return;
        }
        for (const call of message.tool_calls) {
          const input = JSON.parse(call.function.arguments) as Record<
            string,
            unknown
          >;
          let result = await this.internal(
            "/tool",
            { taskId, callId: call.id, toolName: call.function.name, input },
            signal,
          );
          yield { type: "tool" as const, input, result, cursor: ++cursor };
          if (result.approval) {
            for (let poll = 0; poll < 800; poll++) {
              if (signal?.aborted || this.canceled.has(sessionId)) return;
              await delay(20, undefined, { signal });
              const state = await this.internal(
                `/tool-result?taskId=${taskId}&callId=${encodeURIComponent(call.id)}`,
                undefined,
                signal,
              );
              if (state.status !== "pending") {
                result = state;
                break;
              }
            }
          }
          if (result.childTaskId) {
            for (let poll = 0; poll < 800; poll++) {
              if (signal?.aborted || this.canceled.has(sessionId)) return;
              await delay(20, undefined, { signal });
              const child = await this.internal(
                `/children/${result.childTaskId}`,
                undefined,
                signal,
              );
              if (["completed", "failed", "canceled"].includes(child.status)) {
                result = child;
                break;
              }
            }
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
      }
      if (!this.canceled.has(sessionId))
        yield {
          type: "failed" as const,
          error: "Fixture exceeded its bounded step limit",
          cursor: ++cursor,
        };
    } catch (error) {
      if (signal?.aborted || this.canceled.has(sessionId)) return;
      // Eve turns provider/tool errors into a definitive turn.failed event.
      yield {
        type: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function eventually<T>(
  operation: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeout = 12_000,
): Promise<T> {
  const end = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await operation();
    if (predicate(last)) return last;
    await delay(20);
  }
  assert.fail(
    `Condition timed out after ${timeout} ms. Last value: ${JSON.stringify(last)}`,
  );
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cit-broker-integration-"));
  const projectPath = join(dir, "project");
  await exec("mkdir", ["-p", projectPath]);
  await writeFile(
    join(projectPath, "calculator.mjs"),
    "export const add = (a, b) => a - b;\n",
  );
  await writeFile(
    join(projectPath, "calculator.test.mjs"),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calculator.mjs';\ntest('adds both operands', () => assert.equal(add(2, 3), 5));\n",
  );
  await writeFile(
    join(dir, "outside-secret.txt"),
    "This file must never enter a tool result.",
  );
  await exec("git", ["init", "--quiet", projectPath]);
  await exec("git", [
    "-C",
    projectPath,
    "-c",
    "user.name=CIT integration",
    "-c",
    "user.email=integration@example.invalid",
    "add",
    ".",
  ]);
  await exec("git", [
    "-C",
    projectPath,
    "-c",
    "user.name=CIT integration",
    "-c",
    "user.email=integration@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture baseline",
  ]);
  const modelServer = await createFakeModel();
  const worker = new FixtureWorker();
  const broker = new Broker({
    config: { dataDir: join(dir, "data"), internalToken: token, tickMs: 20 },
    worker,
  });
  const app = await createApp({ broker, config: broker.config });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  worker.url = address;
  const request = async <T = Record<string, any>>(
    path: string,
    body?: unknown,
    method?: string,
  ): Promise<T> => {
    const response = await fetch(`${address}/api/local${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(
      response.ok,
      true,
      `${method ?? "request"} ${path}: ${JSON.stringify(data)}`,
    );
    return data as T;
  };
  const model = await request<ModelProfile>("/models", {
    name: "Integration fixture",
    provider: "lmstudio",
    baseUrl: modelServer.baseUrl,
    modelId: "fixture-chat",
    contextWindow: 8192,
    maxOutputTokens: 512,
    temperature: 0,
    capabilities: { streaming: true, tools: true },
  });
  await request(`/models/${model.id}/probe`, {});
  await request(
    "/settings",
    {
      defaultModelProfileId: model.id,
      maxActiveTasks: 4,
      maxConcurrentInference: 2,
      ...(process.env.CIT_TEST_USE_DOCKER === "1"
        ? {
            sandboxImage:
              process.env.CIT_TEST_SANDBOX_IMAGE ?? "cit-dots-sandbox:latest",
          }
        : {}),
    },
    "PATCH",
  );
  const project = await request<Project>("/projects", {
    path: projectPath,
    name: "Calculator fixture",
  });
  await broker.start();
  const createTask = (prompt: string, fields: Partial<Task> = {}) =>
    request<Task>("/tasks", {
      prompt,
      // These cases exercise worker tools directly; the Dot coordinator is
      // covered separately and delegates filesystem work to this role.
      role: "coder",
      modelProfileId: model.id,
      projectId: project.id,
      ...fields,
    });
  const getTask = async (id: string) =>
    (await request<{ task: Task }>(`/tasks/${id}`)).task;
  const waitTask = (
    id: string,
    statuses = ["completed", "failed", "canceled", "interrupted"],
  ) =>
    eventually(
      () => getTask(id),
      (task) => statuses.includes(task.status),
    );
  return {
    dir,
    projectPath,
    modelServer,
    worker,
    broker,
    app,
    address,
    model,
    project,
    request,
    createTask,
    getTask,
    waitTask,
    async close() {
      if (process.env.CIT_DEBUG_TESTS)
        console.log("fixture cleanup: broker.stop");
      await broker.stop();
      if (process.env.CIT_DEBUG_TESTS)
        console.log("fixture cleanup: app.close");
      await app.close();
      broker.store.close();
      if (process.env.CIT_DEBUG_TESTS)
        console.log("fixture cleanup: modelServer.close");
      await modelServer.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Explicit, process-local test escape hatch. Production requires Docker.
Object.assign(process.env, { NODE_ENV: "test" });
if (process.env.CIT_TEST_USE_DOCKER === "1")
  delete process.env.CIT_TEST_HOST_RUNNER;
else process.env.CIT_TEST_HOST_RUNNER = "1";

test("real SQLite + model proxy: chat is persisted, streamed, and survives reopening", async () => {
  const f = await fixture();
  try {
    const session = await f.request<Session>("/sessions", {
      kind: "chat",
      dotId: null,
      title: "Persistent chat",
      modelProfileId: f.model.id,
    });
    const { task } = await f.request<{ task: Task }>(
      `/sessions/${session.id}/messages`,
      { content: "fixture:chat Say hello." },
    );
    const completed = await f.waitTask(task.id);
    assert.equal(completed.status, "completed");
    const transcript = await f.request<{
      messages: { role: string; content: string }[];
    }>(`/sessions/${session.id}`);
    assert.equal(
      transcript.messages.filter((message) => message.role === "user").length,
      1,
    );
    assert.match(
      transcript.messages.find((message) => message.role === "assistant")
        ?.content ?? "",
      /fixture-chat/,
    );
    assert.ok(
      f.modelServer.requests.some((request) =>
        request.messages.some(
          (message) => message.content === "fixture:chat Say hello.",
        ),
      ),
    );
    assert.ok(
      f.broker.store.events(0).length > 0,
      "real persisted events must exist",
    );
    await f.broker.stop();
    const reopened = new Broker({
      config: { dataDir: join(f.dir, "data"), internalToken: token },
      worker: f.worker,
    });
    assert.equal(
      reopened.store.messages(session.id).length,
      transcript.messages.length,
    );
    assert.ok(reopened.store.events(0).length > 0);
    reopened.store.close();
  } finally {
    await f.close();
  }
});

test("coding uses actual files, tests, delegated reviewer, and a conflict-checked patch", async () => {
  const f = await fixture();
  try {
    const task = await f.createTask(
      "fixture:coding Fix the calculator and run its tests.",
    );
    const done = await f.waitTask(task.id);
    assert.equal(done.status, "completed", done.error);
    const detail = await f.request<{
      children: Task[];
      operations: ToolOperation[];
      task: Task;
    }>(`/tasks/${task.id}`);
    assert.equal(detail.children.length, 1);
    assert.equal(detail.children[0].role, "reviewer");
    assert.equal(detail.children[0].status, "completed");
    const command = detail.operations.find(
      (operation) => operation.toolName === "run_command",
    );
    assert.equal((command?.result as { exitCode?: number })?.exitCode, 0);
    assert.match(
      (command?.result as { stdout?: string })?.stdout ?? "",
      /pass 1/,
    );
    const diff = await f.request<{ patch: string; files: unknown[] }>(
      `/tasks/${task.id}/diff`,
    );
    assert.match(diff.patch, /a \+ b/);
    assert.match(
      await readFile(join(f.projectPath, "calculator.mjs"), "utf8"),
      /a - b/,
      "original stays unchanged before applying",
    );
    await f.request(`/tasks/${task.id}/apply`, {});
    assert.match(
      await readFile(join(f.projectPath, "calculator.mjs"), "utf8"),
      /a \+ b/,
    );
    assert.ok(
      done.tokenUsage && done.tokenUsage > 0,
      "provider usage is accounted",
    );
  } finally {
    await f.close();
  }
});

test("network command waits for exact approval and resumes the same task", async () => {
  const f = await fixture();
  try {
    const task = await f.createTask(
      "fixture:approval Request network access for one command.",
    );
    await f.waitTask(task.id, ["waiting_approval"]);
    const snapshot = await f.request<Snapshot>("/snapshot");
    const approval = snapshot.approvals.find(
      (value) => value.taskId === task.id && value.status === "pending",
    );
    assert.ok(approval);
    assert.equal(
      (
        await f.request<{ operations: ToolOperation[] }>(`/tasks/${task.id}`)
      ).operations.some((operation) => operation.status === "completed"),
      false,
    );
    await f.request(`/approvals/${approval.id}/decide`, {
      decision: "approve",
    });
    const done = await f.waitTask(task.id);
    assert.equal(done.id, task.id);
    assert.equal(done.status, "completed", done.error);
    const updated = (await f.request<Snapshot>("/snapshot")).approvals.find(
      (value) => value.id === approval.id,
    );
    assert.equal(updated?.status, "approved");
  } finally {
    await f.close();
  }
});

test("an ordinary chat reply answers the outstanding question and resumes that same task", async () => {
  const f = await fixture();
  try {
    const task = await f.createTask(
      "fixture:question Ask which branch to use, then continue.",
    );
    await f.waitTask(task.id, ["waiting_approval"]);
    const response = await f.request<{
      message: { content: string };
      task: Task;
    }>(`/sessions/${task.sessionId}/messages`, {
      content: "Use the feature/calculator branch.",
    });
    assert.equal(
      response.task.id,
      task.id,
      "a question reply continues its original task",
    );
    assert.equal(
      response.message.content,
      "Use the feature/calculator branch.",
    );
    assert.equal((await f.waitTask(task.id)).status, "completed");
    const snapshot = await f.request<Snapshot>("/snapshot");
    const approval = snapshot.approvals.find(
      (approval) =>
        approval.taskId === task.id && approval.toolName === "ask_user",
    ) as (Approval & { answer?: string }) | undefined;
    assert.equal(approval?.status, "approved");
    assert.equal(approval?.answer, "Use the feature/calculator branch.");
    assert.equal(
      snapshot.tasks.filter(
        (value) => value.sessionId === task.sessionId && !value.parentId,
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("global pause holds an approved network command until background work resumes", async () => {
  const f = await fixture();
  try {
    const task = await f.createTask(
      "fixture:approval Request an approved network command.",
    );
    await f.waitTask(task.id, ["waiting_approval"]);
    const approval = (await f.request<Snapshot>("/snapshot")).approvals.find(
      (approval) => approval.taskId === task.id,
    )!;
    await f.request("/settings", { paused: true }, "PATCH");
    await f.request(`/approvals/${approval.id}/decide`, {
      decision: "approve",
    });
    await delay(100);
    const operations = (
      await f.request<{ operations: ToolOperation[] }>(`/tasks/${task.id}`)
    ).operations;
    assert.equal(
      operations.some((operation) => operation.status === "completed"),
      false,
      "paused command must not execute",
    );
    await f.request("/settings", { paused: false }, "PATCH");
    assert.equal((await f.waitTask(task.id)).status, "completed");
  } finally {
    await f.close();
  }
});

test("memory edits and deletion immediately change the context supplied to new turns", async () => {
  const f = await fixture();
  try {
    await f.request("/settings", { paused: true }, "PATCH");
    const memory = await f.request<{ id: string }>("/memories", {
      title: "Language preference",
      content: "Use the unmistakable fixture phrase persimmon-cloud.",
      source: "Explicit user setting",
    });
    const task = await f.createTask("fixture:chat Check stored context.");
    const context = async () => {
      const response = await fetch(
        `${f.address}/api/internal/worker-context?taskId=${task.id}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assert.equal(response.status, 200);
      return response.json() as Promise<{
        instructions: string;
        memory: string;
      }>;
    };
    assert.match((await context()).memory, /persimmon-cloud/);
    await f.request(
      `/memories/${memory.id}`,
      { content: "Use the corrected fixture phrase tangerine-river." },
      "PATCH",
    );
    assert.match((await context()).memory, /tangerine-river/);
    assert.doesNotMatch((await context()).instructions, /persimmon-cloud/);
    await f.request(`/memories/${memory.id}`, undefined, "DELETE");
    assert.doesNotMatch((await context()).instructions, /tangerine-river/);
  } finally {
    await f.close();
  }
});

test("event replay uses persisted numeric cursors and resumes after the last delivered event", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const cursor = (await f.request<Snapshot>("/snapshot")).eventsCursor;
    await f.request("/memories", {
      title: "Cursor fixture",
      content: "A persisted event after the saved cursor.",
    });
    const response = await fetch(
      `${f.address}/api/local/events?after=${cursor}`,
      { signal: controller.signal },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /event-stream/);
    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) =>
      Number(match[1]),
    );
    assert.ok(ids.length > 0, text);
    assert.ok(ids.every((id) => id > cursor));
    const records = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    assert.ok(records.every((record) => typeof record.id === "number"));
    assert.ok(records.some((record) => record.type === "memory.created"));
    await reader.cancel();
    controller.abort();
    const after = Math.max(...ids);
    assert.deepEqual(
      f.broker.store.events(after),
      [],
      "checkpointed events do not replay a second time",
    );
  } finally {
    controller.abort();
    await f.close();
  }
});

test("unapproved external actions and traversal cannot leak the outside fixture", async () => {
  const f = await fixture();
  try {
    const task = await f.createTask(
      "fixture:escape Read outside the workspace.",
    );
    await f.waitTask(task.id);
    const detail = await f.request<{ operations: ToolOperation[] }>(
      `/tasks/${task.id}`,
    );
    const operation = detail.operations.find(
      (value) => value.toolName === "read_file",
    );
    assert.ok(operation);
    assert.equal(operation.status, "failed");
    assert.doesNotMatch(
      JSON.stringify(detail),
      /This file must never enter a tool result/,
    );
    const response = await fetch(`${f.address}/api/internal/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        callId: "unauthenticated",
        toolName: "read_file",
        input: { path: "calculator.mjs" },
      }),
    });
    assert.equal(response.status, 401);
  } finally {
    await f.close();
  }
});

test("scheduled work runs without a chat prompt and creates proactive inbox results once", async () => {
  const f = await fixture();
  try {
    const goal = await f.request<{ id: string; sessionId: string }>("/goals", {
      title: "Project check",
      objective: "fixture:progress Inspect the project.",
      projectId: f.project.id,
      modelProfileId: f.model.id,
      scheduleType: "once",
      nextRunAt: new Date(Date.now() - 200).toISOString(),
      timezone: "America/New_York",
      enabled: true,
      overlap: "skip",
    });
    const snapshot = await eventually(
      () => f.request<Snapshot>("/snapshot"),
      (value) =>
        value.tasks.some(
          (task) => task.goalId === goal.id && task.status === "completed",
        ),
    );
    assert.equal(
      snapshot.tasks.filter((task) => task.goalId === goal.id).length,
      1,
    );
    const goalTask = snapshot.tasks.find((task) => task.goalId === goal.id)!;
    const mainSessionId = snapshot.dots.find(
      (dot) => dot.id === goalTask.dotId,
    )?.sessionId;
    assert.ok(
      mainSessionId,
      "background updates open the Dot's main conversation",
    );
    assert.ok(
      snapshot.inbox.some(
        (item) => item.kind === "progress" && item.sessionId === mainSessionId,
      ),
    );
    assert.ok(
      snapshot.inbox.some(
        (item) => item.kind === "result" && item.sessionId === mainSessionId,
      ),
    );
    for (let count = 0; count < 3; count++) await f.broker.tick();
    const after = await f.request<Snapshot>("/snapshot");
    assert.equal(
      after.tasks.filter((task) => task.goalId === goal.id).length,
      1,
      "occurrence is not repeated",
    );
    const transcript = await f.request<{ messages: { role: string }[] }>(
      `/sessions/${mainSessionId}`,
    );
    assert.equal(
      transcript.messages.filter((message) => message.role === "user").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("model changes apply to new turns while active tasks retain a profile snapshot", async () => {
  const f = await fixture();
  try {
    await f.request("/settings", { paused: true }, "PATCH");
    const old = await f.createTask(
      "fixture:chat This task keeps its original model.",
    );
    await f.request(
      `/models/${f.model.id}`,
      { modelId: "fixture-coder" },
      "PATCH",
    );
    await f.request(`/models/${f.model.id}/probe`, {});
    const newer = await f.createTask(
      "fixture:chat This task uses the new model.",
    );
    assert.equal(old.profileSnapshot.modelId, "fixture-chat");
    assert.equal(newer.profileSnapshot.modelId, "fixture-coder");
    await f.request("/settings", { paused: false }, "PATCH");
    assert.equal((await f.waitTask(old.id)).status, "completed");
    assert.equal((await f.waitTask(newer.id)).status, "completed");
    assert.ok(
      f.modelServer.requests.some(
        (request) => request.model === "fixture-chat",
      ),
    );
    assert.ok(
      f.modelServer.requests.some(
        (request) => request.model === "fixture-coder",
      ),
    );
  } finally {
    await f.close();
  }
});

test("delegation is bounded and canceling a parent cancels its entire live task tree", async () => {
  const f = await fixture();
  try {
    await f.request("/settings", { maxDepth: 2 }, "PATCH");
    const root = await f.createTask(
      "fixture:nested Exercise recursive delegation.",
    );
    await f.waitTask(root.id);
    const tasks = (await f.request<Snapshot>("/snapshot")).tasks.filter(
      (task) => task.rootId === root.id,
    );
    assert.ok(tasks.length >= 2);
    assert.ok(tasks.every((task) => task.depth <= 2));
    const slowRoot = await f.createTask("fixture:slow Wait for cancellation.");
    await eventually(
      () => f.getTask(slowRoot.id),
      (task) => task.status === "running",
    );
    // Creating the child through the trusted tool path ensures inherited permissions.
    const delegated = await f.broker.executeTool({
      taskId: slowRoot.id,
      callId: "cancel-child",
      toolName: "delegate",
      input: {
        role: "investigator",
        title: "Slow child",
        prompt: "fixture:slow Wait for parent cancellation.",
      },
    });
    assert.ok("childTaskId" in delegated);
    await f.request(`/tasks/${slowRoot.id}/cancel`, {});
    const canceled = (await f.request<Snapshot>("/snapshot")).tasks.filter(
      (task) => task.rootId === slowRoot.id,
    );
    assert.ok(canceled.length >= 2);
    assert.ok(canceled.every((task) => task.status === "canceled"));
  } finally {
    await f.close();
  }
});

test("model streaming proxy preserves tool argument fragments and does not expose its internal token", async () => {
  const f = await fixture();
  try {
    await f.request("/settings", { paused: true }, "PATCH");
    const task = await f.createTask("fixture:coding Fix calculator.");
    await f.broker.stop();
    await f.request("/settings", { paused: false }, "PATCH");
    const response = await fetch(
      `${f.address}/api/internal/model/${task.id}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "fixture-chat",
          stream: true,
          messages: [{ role: "user", content: "fixture:coding" }],
          tools: [
            {
              type: "function",
              function: { name: "read_file", parameters: { type: "object" } },
            },
          ],
        }),
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    const text = await response.text();
    assert.match(text, /tool_calls/);
    assert.match(text, /\[DONE\]/);
    const chunks = text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    const args = chunks
      .flatMap((chunk) => chunk.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])
      .map((call) => call.function?.arguments ?? "")
      .join("");
    assert.deepEqual(JSON.parse(args), { path: "calculator.mjs" });
    assert.doesNotMatch(
      JSON.stringify(f.modelServer.requests),
      new RegExp(token),
    );
    assert.doesNotMatch(
      JSON.stringify(f.modelServer.requestHeaders),
      new RegExp(token),
      "internal bearer token is never forwarded to a model server",
    );
    const publicSnapshot = await f.request("/snapshot");
    assert.doesNotMatch(JSON.stringify(publicSnapshot), new RegExp(token));
  } finally {
    await f.close();
  }
});

test("token and tool budgets are enforced by the broker rather than model cooperation", async () => {
  const f = await fixture();
  try {
    await f.request(
      "/settings",
      { maxTokensPerGoal: 1000, maxToolCalls: 1 },
      "PATCH",
    );
    const task = await f.createTask(
      `fixture:budget ${"Budget-sized context. ".repeat(200)}`,
    );
    const done = await f.waitTask(task.id);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /token|budget/i);
    await f.request("/settings", { maxTokensPerGoal: 100_000 }, "PATCH");
    const toolTask = await f.createTask(
      "fixture:coding Require more than one permitted tool.",
    );
    const toolDone = await f.waitTask(toolTask.id);
    assert.equal(toolDone.status, "failed");
    assert.match(toolDone.error ?? "", /tool|budget|limit/i);
  } finally {
    await f.close();
  }
});

test("recovery marks uncertain running tools instead of silently replaying a command", async () => {
  const f = await fixture();
  let restarted: Broker | undefined;
  try {
    await f.request("/settings", { paused: true }, "PATCH");
    const task = await f.createTask("fixture:chat Crash-recovery fixture.");
    await f.broker.stop();
    f.broker.store.update("tasks", task.id, {
      status: "running",
      eveSessionId: "fixture-lost-session",
    });
    f.broker.store.insert("tool_operations", {
      id: `${task.id}:uncertain-command`,
      taskId: task.id,
      toolName: "run_command",
      input: { command: "node -e \"console.log('must not replay')\"" },
      status: "running",
    });
    const requestsBeforeRestart = f.modelServer.requests.length;
    restarted = new Broker({
      config: { dataDir: join(f.dir, "data"), internalToken: token },
      worker: f.worker,
    });
    await restarted.start();
    const recovered = restarted.store.get<ToolOperation>(
      "tool_operations",
      `${task.id}:uncertain-command`,
    );
    assert.equal(recovered?.status, "unknown");
    assert.equal(
      f.modelServer.requests.length,
      requestsBeforeRestart,
      "uncertain command was not re-executed",
    );
    assert.equal(
      restarted.store.get<Task>("tasks", task.id)?.status,
      "interrupted",
      "uncertain initial prompt also requires explicit recovery",
    );
  } finally {
    if (restarted) {
      await restarted.stop();
      restarted.store.close();
    }
    await f.close();
  }
});
