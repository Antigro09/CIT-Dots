import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/server/api";
import { Broker, type WorkerClient } from "../src/server/broker";
import type { DesktopStatus } from "../src/server/desktops";
import type {
  ComputerAction,
  ComputerControlMode,
  ComputerControlStatus,
  ComputerResult,
} from "../src/shared/computer";
import type { ModelProfile, Task, ToolOperation } from "../src/shared/types";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S8AAAAASUVORK5CYII=";

/** The test display records which owned computer actually receives input. */
class ControlledDesktop {
  readonly calls: { dotId: string; action: ComputerAction }[] = [];
  readonly modes = new Map<string, ComputerControlStatus>();
  readonly positions = new Map<string, { x: number; y: number }>();
  readonly signals: AbortSignal[] = [];
  readonly controlChanges: { dotId: string; mode: ComputerControlMode }[] = [];
  blockNextInput = false;
  cleanupGate?: Promise<void>;
  async status(dotId: string): Promise<DesktopStatus> {
    return {
      dotId,
      state: "running",
      url: "http://127.0.0.1:6080/vnc.html",
      os: "Ubuntu 26.04",
    };
  }
  async start(dotId: string) {
    return this.status(dotId);
  }
  async stop(dotId: string): Promise<DesktopStatus> {
    return { ...(await this.status(dotId)), state: "stopped", url: null };
  }
  async remove(dotId: string) {
    return this.stop(dotId);
  }
  async containerName(): Promise<string | null> {
    return null;
  }
  async cancelAction() {}
  async controlStatus(dotId: string): Promise<ComputerControlStatus> {
    return (
      this.modes.get(dotId) ?? {
        mode: "agent",
        updatedAt: "2026-10-07T12:00:00.000Z",
      }
    );
  }
  async setControl(dotId: string, mode: ComputerControlMode) {
    this.controlChanges.push({ dotId, mode });
    const status = { mode, updatedAt: new Date().toISOString() };
    this.modes.set(dotId, status);
    return status;
  }
  async cursor(dotId: string) {
    return {
      width: 1280,
      height: 800,
      cursor: this.positions.get(dotId) ?? { x: 0, y: 0 },
    };
  }
  async action(
    dotId: string,
    action: ComputerAction,
    signal?: AbortSignal,
  ): Promise<ComputerResult> {
    if (signal?.aborted) throw new Error("Computer action canceled.");
    const control = await this.controlStatus(dotId);
    if (
      action.action !== "screenshot" &&
      (control.mode === "human" || control.pending)
    )
      throw new Error("Human control is active; agent input is paused.");
    this.calls.push({ dotId, action });
    if (signal) this.signals.push(signal);
    if (action.action === "move")
      this.positions.set(dotId, { x: action.x, y: action.y });
    if (this.blockNextInput && action.action !== "screenshot") {
      this.blockNextInput = false;
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          // The CLI is aborted first; the guest may still be releasing input.
          void (this.cleanupGate ?? Promise.resolve()).then(() =>
            reject(new Error("Computer action canceled.")),
          );
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return {
      action: action.action,
      ...(await this.cursor(dotId)),
      image: { mimeType: "image/png", data: PNG },
    };
  }
  async close() {}
}

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Computer-control condition timed out.");
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cit-computer-control-"));
  const desktop = new ControlledDesktop();
  const worker: WorkerClient = {
    async workerHealth() {
      return false;
    },
    async createWorkerSession() {
      return randomUUID();
    },
    async sendWorkerMessage() {},
    async cancelWorkerSession() {},
    async *streamWorkerSession() {},
  };
  const broker = new Broker({
    worker,
    desktops: desktop,
    config: { dataDir: directory, tickMs: 60_000 },
  });
  const model = broker.store.insert<ModelProfile>("models", {
    name: "Vision fixture",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "fixture",
    contextWindow: 8192,
    maxOutputTokens: 2048,
    temperature: 0,
    capabilities: { streaming: true, tools: true, vision: true },
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
  const parent = broker.addUserMessage(main.id, {
    content: "Ask a worker to use my computer.",
  }).task;
  const tool = (
    taskId: string,
    input: Record<string, unknown>,
    callId = randomUUID(),
  ) => broker.executeTool({ taskId, callId, toolName: "computer", input });
  const delegate = async (
    role: Task["role"] = "coder",
    owner: Task = parent,
  ) => {
    const result = await broker.executeTool({
      taskId: owner.id,
      callId: randomUUID(),
      toolName: "delegate",
      input: {
        role,
        title: "Use the graphical computer",
        prompt: "Inspect the screen and perform the requested desktop task.",
        wait: false,
      },
    });
    return broker.store.require<Task>("tasks", String(result.childTaskId));
  };
  const api = async (path: string, input?: unknown) => {
    const response = await fetch(`${url}/api/local${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers:
        input === undefined
          ? undefined
          : { "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const body = await response.json();
    assert.equal(response.ok, true, JSON.stringify(body));
    return body;
  };
  return { broker, desktop, model, parent, main, tool, delegate, api };
}

async function rejected(operation: Promise<Record<string, unknown>>) {
  try {
    const result = await operation;
    assert.match(
      String((result.result as { error?: string } | undefined)?.error ?? ""),
      /coordinator|worker|computer|Dot|vision|read.only|control|input|unrecognized/i,
      "A rejected desktop action must explain why it was refused.",
    );
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(
      String(error),
      /coordinator|worker|computer|Dot|vision|read.only|control|input|unrecognized/i,
    );
  }
}

test("graphical tools require a delegated Dot worker with an explicitly enabled vision profile", async (t) => {
  const f = await fixture(t);
  await rejected(f.tool(f.parent.id, { action: "screenshot" }));
  assert.equal(f.broker.store.list("tool_operations").length, 0);
  const independent = f.broker.createSession({ kind: "work", dotId: null });
  const independentTask = f.broker.addUserMessage(independent.id, {
    content: "Use a computer.",
  }).task;
  await rejected(f.tool(independentTask.id, { action: "screenshot" }));
  const child = await f.delegate();
  f.broker.store.update<Task>("tasks", child.id, {
    profileSnapshot: {
      ...child.profileSnapshot,
      capabilities: { streaming: true, tools: true, vision: false },
    },
  });
  await rejected(f.tool(child.id, { action: "screenshot" }));
  f.broker.store.update<Task>("tasks", child.id, {
    profileSnapshot: {
      ...child.profileSnapshot,
      capabilities: { streaming: true, tools: true },
    },
  });
  await rejected(f.tool(child.id, { action: "move", x: 100, y: 100 }));
  assert.equal(f.desktop.calls.length, 0);
});

test("workers receive screenshot pixels internally while public task records and events omit image bytes", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  const callId = randomUUID();
  const result = await f.tool(child.id, { action: "screenshot" }, callId);
  assert.equal((result.result as ComputerResult).image?.data, PNG);
  assert.deepEqual((result.result as ComputerResult).cursor, { x: 0, y: 0 });
  const operation = f.broker.store.require<ToolOperation>(
    "tool_operations",
    `${child.id}:${callId}`,
  );
  assert.equal((operation.result as ComputerResult).image?.data, PNG);
  assert.equal(
    (f.broker.toolResult(child.id, callId).result as ComputerResult).image
      ?.data,
    PNG,
  );
  assert.equal(
    JSON.stringify(await f.api(`/tasks/${child.id}`)).includes(PNG),
    false,
    "Task detail must not put screenshot bytes into browser state.",
  );
  assert.equal(JSON.stringify(f.broker.snapshot()).includes(PNG), false);
  const completed = f.broker.store
    .events()
    .filter(
      (event) => event.type === "tool.completed" && event.taskId === child.id,
    );
  assert.equal(completed.length, 1);
  assert.equal(
    JSON.stringify(completed).includes(PNG),
    false,
    "The persisted events used by SSE must omit screenshot bytes.",
  );
  assert.equal(f.desktop.calls.length, 1);
});

test("mouse-action receipts replay without repeating input or spending another root tool call", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  f.broker.updateSettings({ maxToolCalls: 2 });
  const callId = randomUUID();
  const input = { action: "move", x: 310, y: 220 };
  const first = await f.tool(child.id, input, callId);
  const replayed = await f.tool(child.id, input, callId);
  assert.deepEqual(replayed, first);
  assert.deepEqual((first.result as ComputerResult).cursor, { x: 310, y: 220 });
  assert.equal(f.desktop.calls.length, 1);
  assert.equal(f.broker.store.require<Task>("tasks", f.parent.id).toolCount, 2);
  await assert.rejects(
    f.tool(child.id, { action: "move", x: 311, y: 220 }, callId),
    /changed action/,
  );
  await assert.rejects(
    f.tool(child.id, { action: "click", x: 310, y: 220 }),
    /budget/,
  );
  assert.equal(f.desktop.calls.length, 1);
});

test("read-only specialists can inspect screenshots but cannot move, click, scroll, or type", async (t) => {
  const f = await fixture(t);
  for (const role of ["investigator", "reviewer"] as const) {
    const child = await f.delegate(role);
    const screenshot = await f.tool(child.id, { action: "screenshot" });
    assert.equal((screenshot.result as ComputerResult).image?.data, PNG);
    for (const input of [
      { action: "move", x: 20, y: 30 },
      { action: "click", x: 20, y: 30 },
      { action: "scroll", direction: "down", amount: 3 },
      { action: "type", text: "do not enter this" },
      { action: "key", keys: ["Return"] },
      { action: "drag", x: 20, y: 30, toX: 40, toY: 50 },
    ])
      await rejected(f.tool(child.id, input));
  }
  assert.deepEqual(
    f.desktop.calls.map(({ action }) => action.action),
    ["screenshot", "screenshot"],
  );
});

test("a worker cannot select another Dot's computer through tool arguments", async (t) => {
  const f = await fixture(t);
  const other = f.broker.createDot({ name: "Other Dot" });
  const child = await f.delegate();
  await rejected(
    f.tool(child.id, {
      action: "click",
      x: 100,
      y: 100,
      dotId: other.id,
    }),
  );
  assert.equal(f.desktop.calls.length, 0);
  await f.tool(child.id, { action: "move", x: 100, y: 100 });
  const otherParent = f.broker.addUserMessage(
    f.broker.dotSession(other.id).id,
    { content: "Use my own desktop." },
  ).task;
  const otherChild = await f.delegate("coder", otherParent);
  await f.tool(otherChild.id, { action: "move", x: 200, y: 200 });
  assert.deepEqual(
    f.desktop.calls.map(({ dotId }) => dotId),
    ["dot-primary", other.id],
  );
  assert.deepEqual((await f.desktop.cursor("dot-primary")).cursor, {
    x: 100,
    y: 100,
  });
});

test("human takeover blocks agent input while retaining screenshots and the real cursor position", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  await f.tool(child.id, { action: "move", x: 430, y: 275 });
  const controlPath = "/dots/dot-primary/computer/control";
  const human = await f.api(controlPath, { mode: "human" });
  assert.equal(human.mode, "human");
  const status = await f.api(controlPath);
  assert.equal(status.mode, "human");
  assert.deepEqual(status.cursor, { x: 430, y: 275, width: 1280, height: 800 });
  for (const input of [
    { action: "click", x: 430, y: 275 },
    { action: "type", text: "competing agent input" },
    { action: "scroll", direction: "down" },
  ])
    await rejected(f.tool(child.id, input));
  // A worker must not bypass takeover by sending GUI input through its terminal.
  f.desktop.containerName = async () => "owned-display-fixture";
  await rejected(
    f.broker.executeTool({
      taskId: child.id,
      callId: randomUUID(),
      toolName: "run_command",
      input: { command: "xdotool mousemove 999 999" },
    }),
  );
  f.desktop.containerName = async () => null;
  const screenshot = await f.tool(child.id, { action: "screenshot" });
  assert.equal((screenshot.result as ComputerResult).image?.data, PNG);
  assert.equal(f.desktop.calls.length, 2);
  assert.equal((await f.api(controlPath, { mode: "agent" })).mode, "agent");
  await f.tool(child.id, { action: "click", x: 430, y: 275 });
  assert.equal(f.desktop.calls.length, 3);
  assert.equal((await f.api(controlPath)).lastAction, "click");
});

test("canceling an in-flight computer action aborts its input controller and never replays an uncertain effect", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  f.desktop.blockNextInput = true;
  const callId = randomUUID();
  const request = f.tool(child.id, { action: "move", x: 55, y: 60 }, callId);
  await eventually(() => f.desktop.calls.length === 1);
  await f.broker.cancelTask(child.id);
  await request;
  assert.equal(f.desktop.signals[0]?.aborted, true);
  assert.equal(
    f.broker.store.require<Task>("tasks", child.id).status,
    "canceled",
  );
  assert.notEqual(
    f.broker.store.require<ToolOperation>(
      "tool_operations",
      `${child.id}:${callId}`,
    ).status,
    "completed",
  );
  await assert.rejects(
    f.tool(child.id, { action: "move", x: 55, y: 60 }, callId),
    /no longer active|stopped/,
  );
  assert.equal(f.desktop.calls.length, 1);
});

test("taking control aborts an in-flight agent input and its old receipt remains non-replayable", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  const callId = randomUUID();
  const input = { action: "move", x: 75, y: 85 };
  f.desktop.blockNextInput = true;
  const pending = f.tool(child.id, input, callId);
  await eventually(() => f.desktop.calls.length === 1);
  await f.api("/dots/dot-primary/computer/control", { mode: "human" });
  const stopped = await pending;
  assert.ok((stopped.result as { error?: string }).error);
  assert.equal(f.desktop.signals[0]?.aborted, true);
  await f.api("/dots/dot-primary/computer/control", { mode: "agent" });
  const repeated = await f.tool(child.id, input, callId);
  assert.ok((repeated.result as { error?: string }).error);
  assert.equal(f.desktop.calls.length, 1);
  await f.tool(child.id, { action: "screenshot" });
  assert.equal(f.desktop.calls.length, 2);
});

test("every viewer's ownership GET waits until in-flight takeover cleanup has completed", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  let releaseCleanup!: () => void;
  f.desktop.cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  f.desktop.blockNextInput = true;
  const input = f.tool(child.id, {
    action: "type",
    text: "typing before takeover",
  });
  const path = "/dots/dot-primary/computer/control";
  let takeover: Promise<unknown> | undefined;
  const reads: Promise<unknown>[] = [];
  try {
    await eventually(() => f.desktop.calls.length === 1);
    takeover = f.api(path, { mode: "human" });
    await eventually(() => f.desktop.signals[0]?.aborted === true);
    const observed: unknown[] = [];
    for (let index = 0; index < 2; index++)
      reads.push(
        f.api(path).then((status) => {
          observed.push(status);
          return status;
        }),
      );
    await delay(30);
    assert.equal(
      observed.length,
      0,
      "Other windows must remain view-only until guest cleanup is confirmed.",
    );
    releaseCleanup();
    await input;
    await takeover;
    const statuses = (await Promise.all(reads)) as {
      mode: string;
      pending?: boolean;
    }[];
    assert.ok(
      statuses.every((status) => status.mode === "human" && !status.pending),
    );
  } finally {
    releaseCleanup();
    await Promise.allSettled([
      input,
      ...(takeover ? [takeover] : []),
      ...reads,
    ]);
  }
});

test("a concurrent give-back request runs after takeover has drained the previous input", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  let releaseCleanup!: () => void;
  f.desktop.cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  f.desktop.blockNextInput = true;
  const input = f.tool(child.id, { action: "move", x: 510, y: 280 });
  const path = "/dots/dot-primary/computer/control";
  let takeover: Promise<unknown> | undefined;
  let giveBack: Promise<unknown> | undefined;
  try {
    await eventually(() => f.desktop.calls.length === 1);
    takeover = f.api(path, { mode: "human" });
    await eventually(() => f.desktop.signals[0]?.aborted === true);
    let returned = false;
    giveBack = f.api(path, { mode: "agent" }).then((result) => {
      returned = true;
      return result;
    });
    await delay(30);
    assert.equal(returned, false);
    assert.deepEqual(
      f.desktop.controlChanges.map(({ mode }) => mode),
      ["human"],
    );
    releaseCleanup();
    await Promise.all([input, takeover, giveBack]);
    assert.deepEqual(
      f.desktop.controlChanges.map(({ mode }) => mode),
      ["human", "agent"],
    );
    assert.equal((await f.api(path)).mode, "agent");
  } finally {
    releaseCleanup();
    await Promise.allSettled([
      input,
      ...(takeover ? [takeover] : []),
      ...(giveBack ? [giveBack] : []),
    ]);
  }
});

test("unconfirmed failed cleanup keeps both graphical and terminal input blocked", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  f.desktop.setControl = async (dotId) => {
    f.desktop.modes.set(dotId, {
      mode: "agent",
      pending: true,
      updatedAt: new Date().toISOString(),
    });
    throw new Error("Guest input cleanup could not be confirmed.");
  };
  await assert.rejects(
    f.broker.setComputerControl("dot-primary", "human"),
    /cleanup could not be confirmed/,
  );
  const status = await f.api("/dots/dot-primary/computer/control");
  assert.equal(status.mode, "agent");
  assert.equal(status.pending, true);
  await rejected(f.tool(child.id, { action: "click", x: 100, y: 100 }));
  f.desktop.containerName = async () => "owned-display-fixture";
  await rejected(
    f.broker.executeTool({
      taskId: child.id,
      callId: randomUUID(),
      toolName: "run_command",
      input: { command: "xdotool mousemove 999 999" },
    }),
  );
  assert.equal(
    f.desktop.calls.length,
    0,
    "Pending cleanup must not send new input to the computer.",
  );
  await f.tool(child.id, { action: "screenshot" });
  assert.deepEqual(
    f.desktop.calls.map(({ action }) => action.action),
    ["screenshot"],
  );
});

test("restart marks an interrupted mouse operation unknown instead of issuing input again", async (t) => {
  const f = await fixture(t);
  const child = await f.delegate();
  const callId = randomUUID();
  const input = { action: "click", x: 80, y: 90 };
  f.broker.store.insert<ToolOperation>("tool_operations", {
    id: `${child.id}:${callId}`,
    taskId: child.id,
    toolName: "computer",
    input,
    status: "running",
  });
  f.broker.updateSettings({ paused: true });
  await f.broker.start();
  const operation = f.broker.store.require<ToolOperation>(
    "tool_operations",
    `${child.id}:${callId}`,
  );
  assert.equal(operation.status, "unknown");
  assert.match(operation.error ?? "", /restarted|inspect/);
  const repeated = await f.tool(child.id, input, callId);
  assert.equal((repeated.result as { outcome: string }).outcome, "unknown");
  assert.equal(f.desktop.calls.length, 0);
});
