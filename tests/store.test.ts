import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, DuplicateRecordError } from "../src/server/store";
import type { Message, Session, InboxItem } from "../src/shared/types";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "cit-store-"));
  const file = join(directory, "cit.sqlite");
  const stores: Store[] = [];
  const open = () => {
    const store = new Store(file);
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { file, open };
}

test("conversation and notification states survive service restart without crossing sessions", (t) => {
  const { open } = fixture(t);
  let store = open();
  const session = store.insert<Session>("sessions", {
    title: "Fix the test suite",
    projectId: null,
    modelProfileId: null,
  });
  const other = store.insert<Session>("sessions", {
    title: "Other conversation",
    projectId: null,
    modelProfileId: null,
  });
  assert.ok(session.id);
  assert.equal(session.version, 1);
  assert.equal(Number.isNaN(Date.parse(session.createdAt)), false);
  store.addMessage<Message>(session.id, {
    role: "user",
    content: "Investigate the failures",
  });
  const result = store.addMessage<Message>(session.id, {
    role: "assistant",
    content: "The fix passes",
    kind: "result",
  });
  store.addMessage<Message>(other.id, {
    role: "user",
    content: "A different task",
  });
  const inbox = store.insert<InboxItem>("inbox", {
    sessionId: session.id,
    messageId: result.id,
    title: "Tests passed",
    body: "Review the changes",
    kind: "result",
    read: false,
    delivered: false,
  });
  store.update<InboxItem>("inbox", inbox.id, { delivered: true });
  store.setSetting("defaultModelProfileId", null);
  store.setSetting("maxActiveTasks", 4);
  store.close();

  store = open();
  assert.equal(
    store.get<Session>("sessions", session.id)?.title,
    "Fix the test suite",
  );
  assert.deepEqual(
    store.messages<Message>(session.id).map((message) => message.content),
    ["Investigate the failures", "The fix passes"],
  );
  assert.deepEqual(
    store.messages<Message>(other.id).map((message) => message.content),
    ["A different task"],
  );
  assert.equal(store.get<InboxItem>("inbox", inbox.id)?.delivered, true);
  assert.equal(store.get<InboxItem>("inbox", inbox.id)?.read, false);
  assert.equal(store.getSetting("defaultModelProfileId", "fallback"), null);
  assert.equal(store.getSetting("maxActiveTasks", 1), 4);
});

test("a failed job transaction rolls back its occurrence, task, message, and audit event", (t) => {
  const store = fixture(t).open();
  const occurrence = "2026-10-07T13:00:00Z";
  assert.throws(
    () =>
      store.transaction(() => {
        assert.equal(
          store.claimOccurrence("daily-check", occurrence, "task-failed"),
          true,
        );
        store.insert("tasks", { id: "task-failed", status: "queued" });
        store.addMessage("session", {
          content: "Starting the daily check",
          role: "assistant",
        });
        store.event("task.queued", { taskId: "task-failed" }, "task-failed");
        throw new Error("simulated failure before commit");
      }),
    /simulated failure/,
  );
  assert.equal(store.get("tasks", "task-failed"), undefined);
  assert.equal(store.occurrence("daily-check", occurrence), undefined);
  assert.deepEqual(store.messages("session"), []);
  assert.deepEqual(store.events(), []);

  store.transaction(() => {
    assert.equal(
      store.claimOccurrence("daily-check", occurrence, "task-recovered"),
      true,
    );
    store.insert("tasks", { id: "task-recovered", status: "queued" });
  });
  assert.equal(
    store.occurrence("daily-check", occurrence)?.taskId,
    "task-recovered",
  );
});

test("nested rollback preserves the outer transaction and outer rollback removes nested commits", (t) => {
  const store = fixture(t).open();
  store.transaction(() => {
    store.insert("tasks", { id: "outer", status: "queued" });
    assert.throws(() =>
      store.transaction(() => {
        store.insert("tasks", { id: "inner", status: "queued" });
        throw new Error("inner failed");
      }),
    );
    store.event("outer.saved", {});
  });
  assert.ok(store.get("tasks", "outer"));
  assert.equal(store.get("tasks", "inner"), undefined);
  assert.equal(store.events()[0].type, "outer.saved");
  assert.throws(() =>
    store.transaction(() => {
      store.transaction(() =>
        store.insert("tasks", { id: "nested-commit", status: "queued" }),
      );
      throw new Error("outer failed");
    }),
  );
  assert.equal(store.get("tasks", "nested-commit"), undefined);
});

test("schedule deduplication survives restart and normalizes equivalent timezone representations", (t) => {
  const { open } = fixture(t);
  let store = open();
  assert.equal(
    store.claimOccurrence("goal", "2026-10-07T13:00:00Z", "original"),
    true,
  );
  store.close();
  store = open();
  assert.equal(
    store.claimOccurrence("goal", "2026-10-07T09:00:00-04:00", "duplicate"),
    false,
  );
  assert.equal(
    store.occurrence("goal", "2026-10-07T13:00:00.000Z")?.taskId,
    "original",
  );
  assert.equal(
    store.claimOccurrence("goal", "2026-10-08T13:00:00Z", "next-day"),
    true,
  );
  assert.equal(
    store.claimOccurrence("another-goal", "2026-10-07T13:00:00Z", "other-goal"),
    true,
  );
});

test("record revisions reject stale writers and duplicate insertions preserve existing data", (t) => {
  const { open } = fixture(t);
  const first = open(),
    second = open();
  first.insert("tasks", { id: "task", status: "queued" });
  const stale = second.getVersioned<{ id: string; status: string }>(
    "tasks",
    "task",
  )!;
  const updated = first.update("tasks", "task", { status: "running" });
  assert.equal(updated.version, 2);
  assert.equal(
    second.compareAndSet("tasks", "task", stale.version, {
      id: "task",
      status: "canceled",
    }),
    false,
  );
  assert.equal(
    second.get<{ status: string }>("tasks", "task")?.status,
    "running",
  );
  assert.throws(
    () => second.insert("tasks", { id: "task", status: "failed" }),
    DuplicateRecordError,
  );
  assert.equal(
    second.compareAndSet("tasks", "task", 2, {
      id: "task",
      status: "completed",
    }),
    true,
  );
  assert.equal(first.getVersioned("tasks", "task")?.version, 3);
  assert.equal(
    first.compareAndSet("tasks", "new", null, { id: "new", status: "queued" }),
    true,
  );
  assert.equal(
    second.compareAndSet("tasks", "new", null, { id: "new", status: "failed" }),
    false,
  );
});

test("memory CAS prevents lost updates across connections and isolates scope namespaces", (t) => {
  const { open } = fixture(t);
  const first = open(),
    second = open();
  const initial = first.compareAndSetKV("notes", "scope", "original", null)!;
  assert.equal(
    second.compareAndSetKV("notes", "scope", "duplicate", null),
    null,
  );
  const firstRead = first.getVersionedKV("notes", "scope")!;
  const secondRead = second.getVersionedKV("notes", "scope")!;
  const write = first.compareAndSetKV(
    "notes",
    "scope",
    "original + first edit",
    firstRead.version,
  )!;
  assert.notEqual(write.version, initial.version);
  assert.equal(
    second.compareAndSetKV(
      "notes",
      "scope",
      "original + stale edit",
      secondRead.version,
    ),
    null,
  );
  assert.equal(
    second.getVersionedKV("notes", "scope")?.content,
    "original + first edit",
  );
  assert.ok(
    second.compareAndSetKV("other-slot", "scope", "independent memory", null),
  );
  assert.equal(
    first.getVersionedKV("other-slot", "scope")?.content,
    "independent memory",
  );
});

test("event replay is bounded, resumes after the last cursor, and continues monotonically after restart", (t) => {
  const { open } = fixture(t);
  let store = open();
  store.transaction(() => {
    for (let index = 0; index < 1205; index++)
      store.event("progress", { index }, index % 2 ? "odd-task" : "even-task");
  });
  const first = store.events(0, 5000);
  assert.equal(first.length, 1000);
  assert.equal(first[0].id, 1);
  const second = store.events(first.at(-1)!.id, 1000);
  assert.equal(second.length, 205);
  assert.equal(second[0].id, 1001);
  assert.equal(
    new Set([...first, ...second].map((event) => event.id)).size,
    1205,
  );
  assert.equal(
    store
      .events(0, 1000, "odd-task")
      .every((event) => event.taskId === "odd-task"),
    true,
  );
  store.close();
  store = open();
  const final = store.event("completed", {}, "even-task");
  assert.equal(final.id, 1206);
  assert.deepEqual(
    store.events(1205).map((event) => event.type),
    ["completed"],
  );
  assert.equal(store.latestCursor(), 1206);
});

test("messages with equal timestamps retain the order they were inserted", (t) => {
  const store = fixture(t).open();
  const createdAt = "2026-10-07T13:00:00.000Z";
  store.addMessage("session", {
    id: "z-user",
    role: "user",
    content: "First",
    createdAt,
  });
  store.addMessage("session", {
    id: "a-assistant",
    role: "assistant",
    content: "Second",
    createdAt,
  });
  assert.deepEqual(
    store
      .messages<{ content: string }>("session")
      .map((message) => message.content),
    ["First", "Second"],
  );
});
