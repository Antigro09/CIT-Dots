import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Broker, type WorkerClient } from "../src/server/broker";
import { createApp } from "../src/server/api";
import type { DesktopStatus } from "../src/server/desktops";
import type {
  Dot,
  Goal,
  Memory,
  Message,
  ModelProfile,
  Session,
  Snapshot,
  Task,
  ToolOperation,
} from "../src/shared/types";
import { createFakeModel } from "./fake-model";

const exec = promisify(execFile);
const primaryId = "dot-primary";
const token = "dot-integration-fixture-only";
type OwnedTask = Task & { dotId: string };
type OwnedSession = Session & { dotId: string };
type OwnedGoal = Goal & { dotId: string };
type OwnedMemory = Memory & { dotId: string };
type DotSnapshot = Snapshot & { dots: Dot[] };

/** Only the workflow process is replaced; storage, HTTP, tools, and files are real. */
class OwnershipWorker implements WorkerClient {
  readonly prompts = new Map<string, string>();
  readonly canceled = new Set<string>();
  private readonly waiting = new Map<string, () => void>();
  async workerHealth() {
    return true;
  }
  async createWorkerSession() {
    return randomUUID();
  }
  async sendWorkerMessage(sessionId: string, _taskId: string, prompt: string) {
    this.prompts.set(sessionId, prompt);
  }
  async cancelWorkerSession(sessionId: string, taskId: string) {
    this.canceled.add(taskId);
    this.waiting.get(sessionId)?.();
  }
  async *streamWorkerSession(
    sessionId: string,
    _taskId: string,
    _after?: number,
    signal?: AbortSignal,
  ) {
    if (this.prompts.get(sessionId)?.includes("hold-until-canceled")) {
      await new Promise<void>((resolve) => {
        this.waiting.set(sessionId, resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
        if (signal?.aborted) resolve();
      });
      this.waiting.delete(sessionId);
      return;
    }
    yield {
      type: "text" as const,
      text: "The owned task completed.",
      cursor: 1,
    };
    yield { type: "completed" as const, cursor: 2 };
  }
}

/** Explicit lifecycle boundary for default tests; never presents a live desktop. */
class StoppedDesktopFixture {
  constructor(private readonly removeFailure?: string) {}
  async status(dotId: string): Promise<DesktopStatus> {
    return { dotId, state: "stopped", url: null, os: "Ubuntu 26.04" };
  }
  async start(_dotId: string): Promise<DesktopStatus> {
    throw new Error("This test fixture does not provide a graphical desktop.");
  }
  async stop(dotId: string) {
    return this.status(dotId);
  }
  async remove(dotId: string): Promise<DesktopStatus> {
    return this.removeFailure
      ? {
          dotId,
          state: "error",
          url: null,
          os: "Ubuntu 26.04",
          error: this.removeFailure,
        }
      : this.status(dotId);
  }
  async containerName(_dotId: string): Promise<string | null> {
    return null;
  }
}

async function eventually<T>(
  read: () => T | Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  const end = Date.now() + 10_000;
  let value: T | undefined;
  while (Date.now() < end) {
    value = await read();
    if (accepts(value)) return value;
    await delay(20);
  }
  assert.fail(`Dot condition timed out: ${JSON.stringify(value)}`);
}

async function fixture(
  options: { models?: boolean; desktopRemoveFailure?: string } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "cit-dot-integration-"));
  const dataDir = join(dir, "data");
  const projectPath = join(dir, "original-project");
  await mkdir(projectPath);
  await writeFile(
    join(projectPath, "original.txt"),
    "User-owned project contents must be preserved.\n",
  );
  await exec("git", ["init", "--quiet", projectPath]);
  await exec("git", ["-C", projectPath, "add", "."]);
  await exec("git", [
    "-C",
    projectPath,
    "-c",
    "user.name=Dot test",
    "-c",
    "user.email=dot-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Original project",
  ]);
  const provider = await createFakeModel();
  const worker = new OwnershipWorker();
  const config = { dataDir, internalToken: token, tickMs: 20 };
  const desktops =
    options.desktopRemoveFailure || process.env.CIT_TEST_DESKTOP !== "1"
      ? new StoppedDesktopFixture(options.desktopRemoveFailure)
      : undefined;
  let broker = new Broker({ config, worker, desktops });
  let app = createApp({ broker });
  let url = await app.listen({ host: "127.0.0.1", port: 0 });
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${url}/api/local${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, body: (await response.json()) as any };
  };
  const local = async <T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    method?: string,
  ): Promise<T> => {
    const result = await call(path, body, method);
    assert.equal(
      result.response.ok,
      true,
      `${path}: ${JSON.stringify(result.body)}`,
    );
    return result.body as T;
  };
  const reject = async (path: string, body?: unknown, method?: string) => {
    const result = await call(path, body, method);
    assert.equal(
      result.response.ok,
      false,
      `Ownership violation accepted at ${path}`,
    );
    assert.equal(typeof result.body.error, "string");
    return String(result.body.error);
  };
  const models: ModelProfile[] = [];
  for (const modelId of options.models === false
    ? []
    : ["fixture-chat", "fixture-coder"]) {
    const profile = await local<ModelProfile>("/models", {
      name: modelId,
      provider: "lmstudio",
      baseUrl: provider.baseUrl,
      modelId,
      contextWindow: 8192,
      maxOutputTokens: 512,
      temperature: 0,
    });
    models.push(await local<ModelProfile>(`/models/${profile.id}/probe`, {}));
  }
  if (models[0])
    await local("/settings", { defaultModelProfileId: models[0].id }, "PATCH");
  const dot = (
    name: string,
    modelProfileId: string | null = models[0]?.id ?? null,
  ) =>
    local<Dot>("/dots", {
      name,
      personality: `Use the distinct personality of ${name}.`,
      avatar: { kind: "robot", color: "#83b6a2" },
      modelProfileId,
    });
  const context = async (taskId: string) => {
    const response = await fetch(
      `${url}/api/internal/worker-context?taskId=${encodeURIComponent(taskId)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(response.ok, true, await response.clone().text());
    return response.json() as Promise<{
      instructions: string;
      memory: string;
      messages: { role: string; content: string }[];
    }>;
  };
  const computerPath = (dotId: string) =>
    join(dataDir, "dots", dotId, "computer");
  return {
    dir,
    dataDir,
    projectPath,
    provider,
    worker,
    models,
    dot,
    call,
    local,
    reject,
    context,
    computerPath,
    get broker() {
      return broker;
    },
    async restart() {
      await broker.stop();
      await app.close();
      broker.store.close();
      broker = new Broker({ config, worker, desktops });
      app = createApp({ broker });
      url = await app.listen({ host: "127.0.0.1", port: 0 });
    },
    async close() {
      await broker.stop();
      await app.close();
      broker.store.close();
      await provider.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("the permanent primary Dot is created once, renamed persistently, and cannot be removed", async () => {
  const f = await fixture();
  try {
    const initial = await f.local<DotSnapshot>("/snapshot");
    assert.equal(initial.dots.filter((dot) => dot.isPrimary).length, 1);
    assert.equal(initial.dots.find((dot) => dot.isPrimary)?.id, primaryId);
    const renamed = await f.local<Dot>(
      `/dots/${primaryId}`,
      {
        name: "Atlas",
        personality: "Explain clearly and keep project notes.",
        avatar: { kind: "cat", color: "#67a48b" },
      },
      "PATCH",
    );
    assert.equal(renamed.name, "Atlas");
    assert.equal(renamed.isPrimary, true);
    await f.reject(`/dots/${primaryId}`, undefined, "DELETE");
    await f.call(`/dots/${primaryId}`, { isPrimary: false }, "PATCH");
    assert.equal(
      (await f.local<DotSnapshot>("/snapshot")).dots.find(
        (dot) => dot.id === primaryId,
      )?.isPrimary,
      true,
    );
    await f.restart();
    const persisted = (await f.local<DotSnapshot>("/snapshot")).dots;
    assert.equal(persisted.filter((dot) => dot.isPrimary).length, 1);
    assert.equal(persisted.find((dot) => dot.id === primaryId)?.name, "Atlas");
    assert.equal(
      persisted.find((dot) => dot.id === primaryId)?.avatar.kind,
      "cat",
    );
  } finally {
    await f.close();
  }
});

test("selecting a Dot applies its own model default and does not change existing tasks", async () => {
  const f = await fixture();
  try {
    const extra = await f.dot("Coder", f.models[1].id);
    await f.local("/settings", { selectedDotId: extra.id }, "PATCH");
    const session = await f.local<OwnedSession>("/sessions", {
      title: "Selected Dot session",
    });
    assert.equal(session.dotId, extra.id);
    const task = await f.local<OwnedTask>("/tasks", {
      sessionId: session.id,
      prompt: "Use my Dot's default model.",
    });
    assert.equal(task.dotId, extra.id);
    assert.equal(task.profileSnapshot.modelId, "fixture-coder");
    await f.local(
      `/dots/${extra.id}`,
      { modelProfileId: f.models[0].id },
      "PATCH",
    );
    const newer = await f.local<OwnedTask>("/tasks", {
      dotId: extra.id,
      prompt: "Use the updated Dot default.",
    });
    assert.equal(newer.profileSnapshot.modelId, "fixture-chat");
    assert.equal(
      f.broker.store.get<Task>("tasks", task.id)?.profileSnapshot.modelId,
      "fixture-coder",
    );
    await f.reject("/settings", { selectedDotId: "missing-dot" }, "PATCH");
    await f.local("/settings", { selectedDotId: primaryId }, "PATCH");
    assert.equal(
      (await f.local<OwnedSession>("/sessions", { title: "Primary chat" }))
        .dotId,
      primaryId,
    );
  } finally {
    await f.close();
  }
});

test("changing a Dot model updates its canonical conversation default while explicit turns override it", async () => {
  const f = await fixture();
  try {
    const dot = await f.dot("Model defaults", f.models[0].id);
    const session = await f.local<OwnedSession>(`/dots/${dot.id}/session`);
    const original = await f.local<{ task: Task }>(
      `/sessions/${session.id}/messages`,
      { content: "hold-until-canceled" },
    );
    await f.broker.start();
    await eventually(
      () => f.broker.store.get<Task>("tasks", original.task.id),
      (task) => task?.status === "running",
    );
    await f.local(
      `/dots/${dot.id}`,
      { modelProfileId: f.models[1].id },
      "PATCH",
    );
    const newDefault = await f.local<{ task: Task }>(
      `/sessions/${session.id}/messages`,
      { content: "Use the Dot's new default model." },
    );
    assert.equal(newDefault.task.profileSnapshot.modelId, "fixture-coder");
    assert.equal(
      f.broker.store.get<Session>("sessions", session.id)?.modelProfileId,
      f.models[1].id,
      "the canonical conversation's picker follows the configured Dot default",
    );
    const override = await f.local<{ task: Task }>(
      `/sessions/${session.id}/messages`,
      {
        content: "Use an explicit model for this turn.",
        modelProfileId: f.models[0].id,
      },
    );
    assert.equal(override.task.profileSnapshot.modelId, "fixture-chat");
    assert.equal(
      f.broker.store.get<Task>("tasks", original.task.id)?.profileSnapshot
        .modelId,
      "fixture-chat",
      "active tasks retain the model snapshot they began with",
    );
  } finally {
    await f.close();
  }
});

test("Dot edits validate identity metadata without allowing primary-status or owner changes", async () => {
  const f = await fixture();
  try {
    await f.reject("/dots", {
      name: "Invalid appearance",
      avatar: { kind: "robot", color: "#11223344" },
    });
    await f.reject("/dots", {
      name: "Invalid appearance",
      avatar: { kind: "owl", color: "#112233" },
    });
    await f.reject("/dots", { name: "x".repeat(5000) });
    const extra = await f.dot("Editable Dot");
    await f.reject(
      `/dots/${extra.id}`,
      { modelProfileId: "missing-model" },
      "PATCH",
    );
    await f.call(
      `/dots/${extra.id}`,
      { isPrimary: true, id: primaryId },
      "PATCH",
    );
    const snapshot = await f.local<DotSnapshot>("/snapshot");
    assert.equal(
      snapshot.dots.find((dot) => dot.id === extra.id)?.isPrimary,
      false,
    );
    assert.equal(snapshot.dots.filter((dot) => dot.isPrimary).length, 1);
    await f.reject("/sessions", {
      dotId: "unregistered-owner",
      title: "Unknown owner",
    });
    await f.reject(
      `/dots/unregistered-owner/computer/file`,
      {
        path: "new.txt",
        content: "No guest root may be created from an unregistered ID.",
      },
      "PUT",
    );
  } finally {
    await f.close();
  }
});

test("personalities and memories enter only their owning Dot's worker context", async () => {
  const f = await fixture();
  try {
    const alpha = await f.dot("Alpha"),
      beta = await f.dot("Beta");
    await f.local(
      `/dots/${alpha.id}`,
      { personality: "Always use the private phrase amber-comet." },
      "PATCH",
    );
    await f.local(
      `/dots/${beta.id}`,
      { personality: "Always use the private phrase cobalt-meadow." },
      "PATCH",
    );
    const alphaMemory = await f.local<OwnedMemory>("/memories", {
      dotId: alpha.id,
      title: "Alpha preference",
      content: "alpha-secret-context",
    });
    await f.local("/memories", {
      dotId: beta.id,
      title: "Beta preference",
      content: "beta-secret-context",
    });
    await f.local("/settings", { selectedDotId: beta.id }, "PATCH");
    const selectedMemory = await f.local<OwnedMemory>("/memories", {
      title: "Selected owner",
      content: "selected-beta-memory",
    });
    assert.equal(selectedMemory.dotId, beta.id);
    const alphaTask = await f.local<OwnedTask>("/tasks", {
      dotId: alpha.id,
      prompt: "Inspect my context.",
    });
    const betaTask = await f.local<OwnedTask>("/tasks", {
      dotId: beta.id,
      prompt: "Inspect my context.",
    });
    const a = await f.context(alphaTask.id),
      b = await f.context(betaTask.id);
    assert.match(a.instructions, /Alpha/);
    assert.match(a.instructions, /amber-comet/);
    assert.match(a.memory, /alpha-secret-context/);
    assert.doesNotMatch(
      a.instructions,
      /beta-secret-context|selected-beta-memory|cobalt-meadow/,
    );
    assert.match(b.instructions, /cobalt-meadow/);
    assert.match(b.memory, /beta-secret-context/);
    assert.doesNotMatch(b.instructions, /alpha-secret-context|amber-comet/);
    await f.call(
      `/memories/${alphaMemory.id}`,
      { dotId: beta.id, content: "Ownership stays with Alpha." },
      "PATCH",
    );
    assert.equal(
      (await f.local<DotSnapshot>("/snapshot")).memories.find(
        (memory) => memory.id === alphaMemory.id,
      )?.dotId,
      alpha.id,
    );
  } finally {
    await f.close();
  }
});

test("session ownership is authoritative for tasks and descendants despite another selected Dot", async () => {
  const f = await fixture();
  try {
    const alpha = await f.dot("Alpha"),
      beta = await f.dot("Beta");
    const a = await f.local<OwnedSession>("/sessions", {
      dotId: alpha.id,
      title: "Alpha conversation",
    });
    const b = await f.local<OwnedSession>("/sessions", {
      dotId: beta.id,
      title: "Beta conversation",
    });
    await f.reject("/tasks", {
      sessionId: a.id,
      dotId: beta.id,
      prompt: "Cross-owner task",
    });
    const root = await f.local<OwnedTask>("/tasks", {
      sessionId: a.id,
      prompt: "Delegate a bounded review.",
      role: "coder",
    });
    await f.local("/settings", { selectedDotId: beta.id }, "PATCH");
    assert.throws(
      () =>
        f.broker.createTask({
          sessionId: b.id,
          parentId: root.id,
          prompt: "Conflicting child conversation",
          role: "reviewer",
        }),
      /dot|owner|session/i,
    );
    const delegated = await f.broker.executeTool({
      taskId: root.id,
      callId: "ownership-child",
      toolName: "delegate",
      input: {
        role: "reviewer",
        title: "Owned reviewer",
        prompt: "Review the parent's work.",
        dotId: beta.id,
      },
    });
    assert.equal(typeof delegated.childTaskId, "string");
    const child = f.broker.store.get<OwnedTask>(
      "tasks",
      String(delegated.childTaskId),
    )!;
    const childSession = f.broker.store.get<OwnedSession>(
      "sessions",
      child.sessionId,
    )!;
    assert.equal(child.dotId, alpha.id);
    assert.equal(childSession.dotId, alpha.id);
    assert.equal(child.parentId, root.id);
    assert.equal(child.rootId, root.id);
    assert.equal(child.workspace?.dotId, alpha.id);
  } finally {
    await f.close();
  }
});

test("scheduled work retains its goal and session owner when the selected Dot changes", async () => {
  const f = await fixture();
  try {
    const alpha = await f.dot("Scheduled Alpha"),
      beta = await f.dot("Selected Beta");
    const session = await f.local<OwnedSession>("/sessions", {
      dotId: alpha.id,
      title: "Owned schedule",
    });
    await f.reject("/goals", {
      sessionId: session.id,
      dotId: beta.id,
      title: "Conflicting schedule",
      objective: "Check ownership.",
      modelProfileId: f.models[0].id,
      scheduleType: "once",
    });
    const goal = await f.local<OwnedGoal>("/goals", {
      sessionId: session.id,
      dotId: alpha.id,
      title: "Alpha check",
      objective: "Run once without a new user message.",
      modelProfileId: f.models[0].id,
      projectId: null,
      scheduleType: "once",
      timezone: "America/New_York",
      nextRunAt: new Date(Date.now() - 100).toISOString(),
      enabled: true,
      overlap: "skip",
    });
    await f.call(`/goals/${goal.id}`, { dotId: beta.id }, "PATCH");
    assert.equal(
      (await f.local<DotSnapshot>("/snapshot")).goals.find(
        (existing) => existing.id === goal.id,
      )?.dotId,
      alpha.id,
    );
    await f.local("/settings", { selectedDotId: beta.id }, "PATCH");
    await f.broker.start();
    const snapshot = await eventually(
      () => f.local<DotSnapshot>("/snapshot"),
      (state) =>
        state.tasks.some(
          (task) => task.goalId === goal.id && task.status === "completed",
        ),
    );
    const tasks = snapshot.tasks.filter((task) => task.goalId === goal.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].dotId, alpha.id);
    assert.equal(tasks[0].sessionId, session.id);
    assert.ok(
      snapshot.inbox.some(
        (item) => item.taskId === tasks[0].id && item.dotId === alpha.id,
      ),
    );
    assert.equal(
      snapshot.inbox.some(
        (item) => item.taskId === tasks[0].id && item.dotId === beta.id,
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test("private computer files persist across restart and cannot traverse into another Dot", async () => {
  const f = await fixture();
  try {
    const alpha = await f.dot("Private Alpha"),
      beta = await f.dot("Private Beta");
    const put = (dotId: string, content: string) =>
      f.local(
        `/dots/${dotId}/computer/file`,
        { path: "notes.txt", content },
        "PUT",
      );
    await put(alpha.id, "Alpha private notes");
    await put(beta.id, "Beta private notes");
    const file = (dotId: string, path = "notes.txt") =>
      f.local<{ path: string; content: string }>(
        `/dots/${dotId}/computer/file?${new URLSearchParams({ path })}`,
      );
    assert.equal((await file(alpha.id)).content, "Alpha private notes");
    assert.equal((await file(beta.id)).content, "Beta private notes");
    await f.reject(
      `/dots/${alpha.id}/computer/file?${new URLSearchParams({ path: `../../${beta.id}/computer/workspace/notes.txt` })}`,
    );
    await symlink(
      join(f.computerPath(beta.id), "workspace"),
      join(f.computerPath(alpha.id), "workspace", "other-dot"),
    );
    await f.reject(
      `/dots/${alpha.id}/computer/file?${new URLSearchParams({ path: "other-dot/notes.txt" })}`,
    );
    await f.restart();
    assert.equal((await file(alpha.id)).content, "Alpha private notes");
    assert.equal((await file(beta.id)).content, "Beta private notes");
    const task = await f.local<OwnedTask>("/tasks", {
      dotId: alpha.id,
      prompt: "Read my persistent private notes.",
      role: "coder",
    });
    const result = await f.broker.executeTool({
      taskId: task.id,
      callId: "private-read",
      toolName: "read_file",
      input: { path: "notes.txt" },
    });
    assert.match(JSON.stringify(result), /Alpha private notes/);
    assert.doesNotMatch(JSON.stringify(result), /Beta private notes/);
    const workspace = f.broker.store.get<OwnedTask>(
      "tasks",
      task.id,
    )?.workspace;
    assert.equal(workspace?.scope, "computer");
    assert.equal(workspace?.dotId, alpha.id);
    await f.broker.cancelTask(task.id);
    await f.reject(`/tasks/${task.id}/apply`, {});
  } finally {
    await f.close();
  }
});

test("removing an extra Dot cancels its work and cleans only its owned records and computer", async () => {
  const f = await fixture();
  try {
    const removed = await f.dot("Remove me"),
      retained = await f.dot("Keep me");
    await f.local(
      `/dots/${primaryId}/computer/file`,
      { path: "primary.txt", content: "Permanent computer contents" },
      "PUT",
    );
    await f.local(
      `/dots/${retained.id}/computer/file`,
      { path: "retained.txt", content: "Other Dot computer contents" },
      "PUT",
    );
    await f.local(
      `/dots/${removed.id}/computer/file`,
      { path: "removed.txt", content: "Only this computer is removed" },
      "PUT",
    );
    const project = await f.local<{ id: string }>("/projects", {
      path: f.projectPath,
      name: "Original project",
    });
    const task = await f.local<OwnedTask>("/tasks", {
      dotId: removed.id,
      projectId: project.id,
      role: "coder",
      prompt: "hold-until-canceled",
    });
    const session = f.broker.store.get<OwnedSession>(
      "sessions",
      task.sessionId,
    )!;
    await f.local(`/sessions/${session.id}/messages`, {
      content: "private-owned-chat-payload",
    });
    await f.broker.executeTool({
      taskId: task.id,
      callId: "isolated-project-change",
      toolName: "write_file",
      input: { path: "original.txt", content: "Agent-only clone change\n" },
    });
    const workspaceRoot = f.broker.store.get<Task>("tasks", task.id)?.workspace
      ?.root;
    assert.ok(workspaceRoot);
    const reviewer = await f.broker.executeTool({
      taskId: task.id,
      callId: "owned-project-review",
      toolName: "delegate",
      input: {
        role: "reviewer",
        title: "Owned project reviewer",
        prompt: "Review the Dot's isolated project change.",
      },
    });
    assert.equal(
      f.broker.store.get<Task>("tasks", String(reviewer.childTaskId))?.workspace
        ?.root,
      workspaceRoot,
      "cleanup must deduplicate a project clone shared by parent and child",
    );
    await f.local("/memories", {
      dotId: removed.id,
      title: "Owned memory",
      content: "Removed only with its Dot",
    });
    const otherMemory = await f.local<OwnedMemory>("/memories", {
      dotId: retained.id,
      title: "Retained memory",
      content: "Still available afterward",
    });
    await f.broker.executeTool({
      taskId: task.id,
      callId: "owned-question",
      toolName: "ask_user",
      input: { question: "An owned unanswered question" },
    });
    const retainedTask = await f.local<OwnedTask>("/tasks", {
      dotId: retained.id,
      prompt: "Retained Dot audit history.",
    });
    await f.local(`/tasks/${retainedTask.id}/cancel`, {});
    const independentSession = await f.local<Session>("/sessions", {
      kind: "chat",
      title: "Independent history survives Dot deletion",
    });
    const independent = await f.local<{ task: Task }>(
      `/sessions/${independentSession.id}/messages`,
      { content: "independent-chat-audit-payload" },
    );
    await f.local(`/tasks/${independent.task.id}/cancel`, {});
    const scheduleTime = "2035-01-01T00:00:00.000Z";
    const schedule = (sessionId: string, title: string) =>
      f.local<Goal>("/goals", {
        sessionId,
        title,
        objective: "Explicit history fixture; do not run automatically.",
        modelProfileId: f.models[0].id,
        scheduleType: "once",
        nextRunAt: scheduleTime,
        enabled: false,
      });
    const ownedGoal = await schedule(session.id, "Owned history"),
      retainedGoal = await schedule(retainedTask.sessionId, "Retained history"),
      independentGoal = await schedule(
        independentSession.id,
        "Independent history",
      );
    assert.equal(
      f.broker.store.claimOccurrence(ownedGoal.id, scheduleTime, task.id),
      true,
    );
    assert.equal(
      f.broker.store.claimOccurrence(
        retainedGoal.id,
        scheduleTime,
        retainedTask.id,
      ),
      true,
    );
    assert.equal(
      f.broker.store.claimOccurrence(
        independentGoal.id,
        scheduleTime,
        independent.task.id,
      ),
      true,
    );
    const legacyGoalId = `legacy-owned-${randomUUID()}`;
    assert.equal(
      f.broker.store.claimOccurrence(legacyGoalId, scheduleTime, task.id),
      true,
    );
    // A second task exercises cancellation of an actually active workflow stream.
    const active = await f.local<OwnedTask>("/tasks", {
      dotId: removed.id,
      prompt: "hold-until-canceled",
      role: "coder",
    });
    await f.broker.start();
    await eventually(
      () => f.broker.store.get<Task>("tasks", active.id),
      (value) => value?.status === "running",
    );
    await f.local("/settings", { selectedDotId: removed.id }, "PATCH");
    const beforeEvents = f.broker.store.events(0, 1000);
    assert.match(JSON.stringify(beforeEvents), /private-owned-chat-payload/);
    assert.match(JSON.stringify(beforeEvents), /An owned unanswered question/);
    assert.match(JSON.stringify(beforeEvents), /Agent-only clone change/);
    const ownedTaskIds = new Set(
      f.broker.store
        .list<Task>("tasks", {
          predicate: (existing) => existing.dotId === removed.id,
        })
        .map((existing) => existing.id),
    );
    const privateEventIds = beforeEvents
      .filter(
        (event) =>
          ownedTaskIds.has(event.taskId || "") ||
          (event.data as { dotId?: string }).dotId === removed.id,
      )
      .map((event) => event.id);
    assert.ok(privateEventIds.length > 0);
    const preservedEvents = beforeEvents.filter(
      (event) =>
        event.taskId === retainedTask.id ||
        event.taskId === independent.task.id ||
        (event.data as { dotId?: string }).dotId === retained.id ||
        /^(model|project|settings)\./.test(event.type),
    );
    assert.ok(
      preservedEvents.some((event) => event.taskId === retainedTask.id),
    );
    assert.ok(
      preservedEvents.some((event) => event.taskId === independent.task.id),
    );
    assert.ok(preservedEvents.some((event) => event.type.startsWith("model.")));
    assert.ok(
      preservedEvents.some((event) => event.type.startsWith("project.")),
    );
    await f.local(`/dots/${removed.id}`, undefined, "DELETE");
    assert.ok(
      f.worker.canceled.has(active.id),
      "the live workflow is canceled before deleting its records",
    );
    const snapshot = await f.local<DotSnapshot>("/snapshot");
    assert.equal(
      snapshot.dots.some((dot) => dot.id === removed.id),
      false,
    );
    assert.equal(snapshot.settings.selectedDotId, primaryId);
    for (const collection of [
      snapshot.sessions,
      snapshot.tasks,
      snapshot.goals,
      snapshot.memories,
      snapshot.inbox,
    ]) {
      assert.equal(
        collection.some((record) => record.dotId === removed.id),
        false,
      );
    }
    assert.equal(f.broker.store.messages(session.id).length, 0);
    assert.equal(
      snapshot.approvals.some((approval) => approval.taskId === task.id),
      false,
    );
    assert.equal(
      f.broker.store.list("tool_operations", {
        predicate: (operation) => operation.taskId === task.id,
      }).length,
      0,
    );
    assert.ok(snapshot.memories.some((memory) => memory.id === otherMemory.id));
    assert.ok(snapshot.projects.some((existing) => existing.id === project.id));
    const afterEvents = f.broker.store.events(0, 1000);
    const afterEventIds = new Set(afterEvents.map((event) => event.id));
    assert.equal(
      privateEventIds.some((id) => afterEventIds.has(id)),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(afterEvents),
      /private-owned-chat-payload|An owned unanswered question|Agent-only clone change/,
    );
    for (const event of preservedEvents) {
      assert.deepEqual(
        afterEvents.find((existing) => existing.id === event.id),
        event,
      );
    }
    assert.equal(
      f.broker.store.occurrence(ownedGoal.id, scheduleTime),
      undefined,
    );
    assert.equal(
      f.broker.store.occurrence(legacyGoalId, scheduleTime),
      undefined,
    );
    assert.equal(
      f.broker.store.occurrence(retainedGoal.id, scheduleTime)?.taskId,
      retainedTask.id,
    );
    assert.equal(
      f.broker.store.occurrence(independentGoal.id, scheduleTime)?.taskId,
      independent.task.id,
    );
    assert.equal(
      await readFile(join(f.projectPath, "original.txt"), "utf8"),
      "User-owned project contents must be preserved.\n",
    );
    await assert.rejects(stat(f.computerPath(removed.id)), { code: "ENOENT" });
    await assert.rejects(stat(workspaceRoot), { code: "ENOENT" });
    assert.equal(
      await readFile(
        join(f.computerPath(primaryId), "workspace", "primary.txt"),
        "utf8",
      ),
      "Permanent computer contents",
    );
    assert.equal(
      await readFile(
        join(f.computerPath(retained.id), "workspace", "retained.txt"),
        "utf8",
      ),
      "Other Dot computer contents",
    );
  } finally {
    await f.close();
  }
});

test("a desktop cleanup failure preserves the Dot, its records, and private files", async () => {
  const f = await fixture({
    desktopRemoveFailure: "The owned desktop could not be safely removed.",
  });
  try {
    const dot = await f.dot("Preserved after cleanup failure");
    const session = await f.local<OwnedSession>(`/dots/${dot.id}/session`);
    const { task } = await f.local<{ task: Task }>(
      `/sessions/${session.id}/messages`,
      { content: "Work whose records must survive a cleanup failure." },
    );
    const memory = await f.local<OwnedMemory>("/memories", {
      dotId: dot.id,
      title: "Retained context",
      content: "The Dot must still own this memory.",
    });
    await f.local(
      `/dots/${dot.id}/computer/file`,
      { path: "retained.txt", content: "Keep these private files." },
      "PUT",
    );
    const error = await f.reject(`/dots/${dot.id}`, undefined, "DELETE");
    assert.match(error, /could not be safely removed/);
    assert.ok(f.broker.store.get<Dot>("dots", dot.id));
    assert.ok(f.broker.store.get<Session>("sessions", session.id));
    assert.ok(f.broker.store.get<Memory>("memories", memory.id));
    assert.equal(
      f.broker.store.get<Task>("tasks", task.id)?.status,
      "canceled",
    );
    assert.equal(
      await readFile(
        join(f.computerPath(dot.id), "workspace", "retained.txt"),
        "utf8",
      ),
      "Keep these private files.",
    );
    assert.equal(
      (
        await f.local<{ path: string; content: string }>(
          `/dots/${dot.id}/computer/file?path=retained.txt`,
        )
      ).content,
      "Keep these private files.",
      "the lifecycle guard is released after failure so preserved data remains accessible",
    );
    await f.restart();
    assert.equal(
      (await f.local<OwnedSession>(`/dots/${dot.id}/session`)).id,
      session.id,
    );
    assert.ok(f.broker.store.get<Memory>("memories", memory.id));
  } finally {
    await f.close();
  }
});

test("background and child questions reach the owning Dot's main conversation and answers resume the child", async () => {
  const f = await fixture();
  try {
    const owner = await f.dot("Background owner"),
      other = await f.dot("Other identity");
    const main = await f.local<OwnedSession>(`/dots/${owner.id}/session`);
    const background = await f.local<OwnedTask>("/tasks", {
      dotId: owner.id,
      prompt: "Work in the background and delegate an investigation.",
    });
    assert.notEqual(background.sessionId, main.id);
    const delegated = await f.broker.executeTool({
      taskId: background.id,
      callId: "background-investigation",
      toolName: "delegate",
      input: {
        role: "investigator",
        prompt: "Ask which branch should be investigated.",
      },
    });
    const childId = String(delegated.childTaskId);
    const child = f.broker.store.require<Task>("tasks", childId);
    assert.notEqual(child.sessionId, main.id);
    const unrelated = await f.local<OwnedTask>("/tasks", {
      dotId: other.id,
      prompt: "An unrelated pending question.",
    });
    await f.broker.executeTool({
      taskId: unrelated.id,
      callId: "other-question",
      toolName: "ask_user",
      input: { question: "Which unrelated project?" },
    });
    await f.broker.executeTool({
      taskId: background.id,
      callId: "background-progress",
      toolName: "report_progress",
      input: { message: "Delegated the branch investigation." },
    });
    const question = await f.broker.executeTool({
      taskId: childId,
      callId: "child-question",
      toolName: "ask_user",
      input: { question: "Which branch should I investigate?" },
    });
    assert.equal(typeof (question.approval as { id: string }).id, "string");
    const transcript = await f.local<{ messages: Message[] }>(
      `/sessions/${main.id}`,
    );
    assert.ok(
      transcript.messages.some(
        (message) =>
          message.taskId === background.id && message.kind === "progress",
      ),
    );
    assert.ok(
      transcript.messages.some(
        (message) => message.taskId === childId && message.kind === "question",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(transcript.messages),
      /unrelated project/,
    );
    const before = f.broker.store.list<Task>("tasks").length;
    await f.local("/settings", { selectedDotId: other.id }, "PATCH");
    const answered = await f.local<{ task: Task; message: Message }>(
      `/sessions/${main.id}/messages`,
      { content: "Investigate feature/desktop." },
    );
    assert.equal(answered.task.id, childId);
    assert.equal(answered.message.sessionId, main.id);
    assert.equal(answered.message.taskId, childId);
    assert.equal(f.broker.store.list<Task>("tasks").length, before);
    const operation = await eventually(
      () =>
        f.broker.store.get<ToolOperation>(
          "tool_operations",
          `${childId}:child-question`,
        ),
      (value) => value?.status === "completed",
    );
    assert.deepEqual(operation?.result, {
      answer: "Investigate feature/desktop.",
    });
    assert.equal(
      f.broker.store.require<Task>("tasks", childId).status,
      "running",
    );
    assert.equal(
      f.broker.store.require<Task>("tasks", background.id).status,
      "waiting_child",
    );
    const snapshot = await f.local<DotSnapshot>("/snapshot");
    assert.ok(
      snapshot.inbox.some(
        (item) => item.taskId === childId && item.sessionId === main.id,
      ),
    );
    assert.equal(
      snapshot.approvals.find((approval) => approval.taskId === unrelated.id)
        ?.status,
      "pending",
    );
  } finally {
    await f.close();
  }
});

test("replies during Dot deletion are rejected before they can answer a canceled question", async () => {
  const f = await fixture();
  let releaseCancellation: (() => void) | undefined;
  let removal: Promise<{ response: Response; body: any }> | undefined;
  try {
    const dot = await f.dot("Removal race");
    const session = await f.local<OwnedSession>(`/dots/${dot.id}/session`);
    const { task } = await f.local<{ task: Task }>(
      `/sessions/${session.id}/messages`,
      { content: "hold-until-canceled" },
    );
    await f.broker.start();
    await eventually(
      () => f.broker.store.get<Task>("tasks", task.id),
      (value) => value?.status === "running",
    );
    await f.broker.executeTool({
      taskId: task.id,
      callId: "question-during-removal",
      toolName: "ask_user",
      input: { question: "Should this canceled operation continue?" },
    });
    const cancellationBarrier = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const originalCancel = f.worker.cancelWorkerSession.bind(f.worker);
    f.worker.cancelWorkerSession = async (sessionId, taskId) => {
      await originalCancel(sessionId, taskId);
      await cancellationBarrier;
    };
    removal = f.call(`/dots/${dot.id}`, undefined, "DELETE");
    await eventually(
      () => f.broker.store.get<Task>("tasks", task.id),
      (value) => value?.status === "canceled",
    );
    const error = await f.reject(`/sessions/${session.id}/messages`, {
      content: "A late reply must not revive the deleted task.",
    });
    assert.match(error, /being removed/);
    assert.equal(
      f.broker.store
        .messages<Message>(session.id)
        .some((message) => message.content.includes("A late reply")),
      false,
    );
    assert.ok(releaseCancellation);
    releaseCancellation();
    assert.equal((await removal).response.ok, true);
    assert.equal(f.broker.store.get<Task>("tasks", task.id), undefined);
  } finally {
    releaseCancellation?.();
    await removal;
    await f.close();
  }
});

test("a Dot opens its canonical persistent conversation before any model is configured", async () => {
  const f = await fixture({ models: false });
  try {
    const main = await f.local<OwnedSession>(`/dots/${primaryId}/session`);
    assert.equal(main.dotId, primaryId);
    assert.equal(main.kind, "dot");
    assert.equal(main.modelProfileId, null);
    assert.equal(
      (await f.local<OwnedSession>(`/dots/${primaryId}/session`)).id,
      main.id,
    );
    const other = await f.dot("Another Dot", null);
    await f.local("/settings", { selectedDotId: other.id }, "PATCH");
    const otherMain = await f.local<OwnedSession>(`/dots/${other.id}/session`);
    assert.notEqual(otherMain.id, main.id);
    assert.equal(otherMain.dotId, other.id);
    assert.equal(
      (await f.local<OwnedSession>(`/dots/${primaryId}/session`)).id,
      main.id,
    );
    await f.restart();
    assert.equal(
      (await f.local<OwnedSession>(`/dots/${primaryId}/session`)).id,
      main.id,
    );
    assert.equal(
      (await f.local<OwnedSession>(`/dots/${other.id}/session`)).id,
      otherMain.id,
    );
    const dots = (await f.local<DotSnapshot>("/snapshot")).dots;
    assert.equal(dots.find((dot) => dot.id === primaryId)?.sessionId, main.id);
    assert.equal(
      dots.find((dot) => dot.id === other.id)?.sessionId,
      otherMain.id,
    );
  } finally {
    await f.close();
  }
});

test("standalone chat stays independent of the selected Dot, its memory, and private computer", async () => {
  const f = await fixture();
  try {
    const selected = await f.dot("Private identity");
    await f.local(
      `/dots/${selected.id}`,
      { personality: "Only this Dot uses plum-harbor-personality." },
      "PATCH",
    );
    await f.local("/memories", {
      dotId: selected.id,
      title: "Personal Dot memory",
      content: "plum-harbor-private-memory",
    });
    await f.local("/memories", {
      dotId: null,
      title: "General context",
      content: "General-independent-context",
    });
    await f.local("/settings", { selectedDotId: selected.id }, "PATCH");
    await f.reject("/sessions", {
      kind: "chat",
      dotId: selected.id,
      title: "Conflicting independent session",
    });
    const session = await f.local<Session>("/sessions", {
      kind: "chat",
      title: "Ordinary chat",
      modelProfileId: f.models[0].id,
    });
    assert.equal(session.kind, "chat");
    assert.equal(session.dotId, null);
    const turn = await f.local<{ task: Task }>(
      `/sessions/${session.id}/messages`,
      { content: "Tell me about this ordinary chat." },
    );
    assert.equal(turn.task.dotId, null);
    assert.equal(turn.task.role, "coordinator");
    const context = await f.context(turn.task.id);
    assert.doesNotMatch(
      context.instructions,
      /plum-harbor-personality|plum-harbor-private-memory/,
    );
    assert.match(context.memory, /General-independent-context/);
    const denied = await f.broker.executeTool({
      taskId: turn.task.id,
      callId: "no-personal-computer",
      toolName: "read_file",
      input: { path: "notes.txt" },
    });
    assert.match(
      JSON.stringify(denied),
      /project|workspace|unavailable|computer/i,
    );
    assert.equal(
      f.broker.store.get<Task>("tasks", turn.task.id)?.workspace,
      undefined,
    );
    await f.restart();
    const stored = f.broker.store.get<Session>("sessions", session.id);
    assert.equal(stored?.dotId, null);
    assert.equal(stored?.kind, "chat");
    assert.equal(f.broker.store.get<Task>("tasks", turn.task.id)?.dotId, null);
  } finally {
    await f.close();
  }
});

test("standalone work uses its project and survives removal of an unrelated Dot", async () => {
  const f = await fixture();
  try {
    const extra = await f.dot("Unrelated removable Dot");
    const project = await f.local<{ id: string }>("/projects", {
      path: f.projectPath,
      name: "Independent work project",
    });
    await f.local("/settings", { selectedDotId: extra.id }, "PATCH");
    const session = await f.local<Session>("/sessions", {
      kind: "work",
      title: "Ordinary coding session",
      projectId: project.id,
      modelProfileId: f.models[1].id,
    });
    assert.equal(session.dotId, null);
    assert.equal(session.kind, "work");
    const { task } = await f.local<{ task: Task }>(
      `/sessions/${session.id}/messages`,
      { content: "Change the original text in an isolated workspace." },
    );
    assert.equal(task.dotId, null);
    assert.equal(task.role, "coder");
    assert.equal(task.profileSnapshot.modelId, "fixture-coder");
    const written = await f.broker.executeTool({
      taskId: task.id,
      callId: "standalone-project-write",
      toolName: "write_file",
      input: {
        path: "original.txt",
        content: "An independent, reviewable change.\n",
      },
    });
    assert.doesNotMatch(JSON.stringify(written), /"error"/);
    const workspace = f.broker.store.get<Task>("tasks", task.id)?.workspace;
    assert.ok(workspace);
    assert.equal(workspace.dotId ?? null, null);
    const delegated = await f.broker.executeTool({
      taskId: task.id,
      callId: "standalone-review",
      toolName: "delegate",
      input: {
        role: "reviewer",
        title: "Independent review",
        prompt: "Review the standalone project's patch.",
      },
    });
    assert.equal(typeof delegated.childTaskId, "string");
    const child = f.broker.store.get<Task>(
      "tasks",
      String(delegated.childTaskId),
    )!;
    assert.equal(child.dotId, null);
    assert.equal(
      f.broker.store.get<Session>("sessions", child.sessionId)?.dotId,
      null,
    );
    assert.equal(child.workspace?.root, workspace.root);
    await f.local(`/dots/${extra.id}`, undefined, "DELETE");
    assert.ok(f.broker.store.get<Session>("sessions", session.id));
    assert.ok(f.broker.store.get<Task>("tasks", task.id));
    assert.ok(f.broker.store.get<ModelProfile>("models", f.models[1].id));
    assert.ok(f.broker.store.get("projects", project.id));
    assert.equal(
      await readFile(join(workspace.root, "original.txt"), "utf8"),
      "An independent, reviewable change.\n",
    );
    assert.equal(
      await readFile(join(f.projectPath, "original.txt"), "utf8"),
      "User-owned project contents must be preserved.\n",
    );
    await f.restart();
    assert.equal(
      f.broker.store.get<Session>("sessions", session.id)?.dotId,
      null,
    );
    assert.equal(f.broker.store.get<Task>("tasks", task.id)?.dotId, null);
    assert.equal(f.broker.store.get<Task>("tasks", child.id)?.dotId, null);
  } finally {
    await f.close();
  }
});
