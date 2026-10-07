import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { PRIMARY_DOT_ID, type Dot } from "../src/shared/types";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "cit-dot-store-"));
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
  return { open };
}

test("the permanent Dot exists without a model and keeps its edited identity after restart", (t) => {
  const { open } = fixture(t);
  let store = open();
  const primary = store.require<Dot>("dots", PRIMARY_DOT_ID);
  assert.equal(primary.name, "Pip");
  assert.equal(primary.isPrimary, true);
  assert.equal(primary.modelProfileId, null);
  assert.deepEqual(primary.avatar, { kind: "blob", color: "#a7e8c7" });
  assert.equal(store.count("models"), 0);
  const edited = store.update<Dot>("dots", PRIMARY_DOT_ID, {
    name: "Clover",
    personality: "A careful coding companion with concise updates.",
    avatar: { kind: "cat", color: "#123456" },
  });
  store.close();
  store = open();
  assert.equal(store.count("dots"), 1);
  assert.deepEqual(store.require<Dot>("dots", PRIMARY_DOT_ID), edited);
  store.close();
  store = open();
  assert.deepEqual(store.require<Dot>("dots", PRIMARY_DOT_ID), edited);
});

test("legacy records migrate to Dot owners and retain their authored payloads", (t) => {
  const { open } = fixture(t);
  let store = open();
  // Version-one databases from before Dots have these same tables but no Dot records.
  store.db.prepare("DELETE FROM records WHERE collection = 'dots'").run();
  store.insert("sessions", {
    id: "legacy-session",
    title: "Earlier conversation",
    projectId: null,
    modelProfileId: null,
  });
  store.insert("tasks", {
    id: "legacy-task",
    sessionId: "legacy-session",
    parentId: null,
    result: "An existing result",
    status: "completed",
  });
  store.insert("goals", {
    id: "legacy-goal",
    sessionId: "legacy-session",
    title: "Earlier goal",
    objective: "Keep this objective",
    enabled: false,
  });
  store.insert("memories", {
    id: "legacy-memory",
    title: "Preference",
    content: "Preserve this text",
    source: "User instruction",
  });
  store.insert("inbox", {
    id: "legacy-inbox",
    sessionId: "legacy-session",
    taskId: "legacy-task",
    body: "Existing notification",
    read: true,
    delivered: false,
  });
  const extra = store.insert<Dot>("dots", {
    id: "dot-extra",
    name: "Atlas",
    personality: "Careful reviewer",
    avatar: { kind: "robot", color: "#abcdef" },
    isPrimary: false,
    modelProfileId: null,
  });
  const ownedSession = store.insert("sessions", {
    id: "extra-session",
    dotId: extra.id,
    title: "Extra Dot conversation",
  });
  const ownedParent = store.insert("tasks", {
    id: "extra-parent",
    sessionId: ownedSession.id,
    dotId: extra.id,
    parentId: null,
    status: "completed",
  });
  store.insert("tasks", {
    id: "extra-child",
    sessionId: ownedSession.id,
    parentId: ownedParent.id,
    status: "completed",
  });
  store.insert("goals", {
    id: "extra-goal",
    sessionId: ownedSession.id,
    objective: "Review weekly",
  });
  const ownedMemory = store.insert("memories", {
    id: "extra-memory",
    dotId: extra.id,
    title: "Owned note",
    content: "Do not reassign this note",
  });
  store.insert("memories", {
    id: "task-memory",
    taskId: ownedParent.id,
    content: "Task-owned legacy note",
  });
  store.insert("inbox", {
    id: "task-inbox",
    sessionId: "legacy-session",
    taskId: ownedParent.id,
    body: "Follow the owning task",
  });
  store.insert("projects", {
    id: "shared-project",
    name: "Shared approved project",
  });
  store.insert("models", { id: "shared-model", name: "Shared model" });
  store.close();

  store = open();
  assert.equal(store.require<Dot>("dots", PRIMARY_DOT_ID).name, "Pip");
  for (const [collection, id] of [
    ["sessions", "legacy-session"],
    ["tasks", "legacy-task"],
    ["goals", "legacy-goal"],
    ["memories", "legacy-memory"],
    ["inbox", "legacy-inbox"],
  ] as const) {
    assert.equal(
      store.require<{ dotId: string }>(collection, id).dotId,
      PRIMARY_DOT_ID,
    );
  }
  for (const [collection, id] of [
    ["tasks", "extra-child"],
    ["goals", "extra-goal"],
    ["memories", "task-memory"],
    ["inbox", "task-inbox"],
  ] as const) {
    assert.equal(
      store.require<{ dotId: string }>(collection, id).dotId,
      extra.id,
    );
  }
  assert.deepEqual(store.require<Dot>("dots", extra.id), extra);
  assert.deepEqual(store.get("sessions", ownedSession.id), ownedSession);
  assert.deepEqual(store.get("tasks", ownedParent.id), ownedParent);
  assert.deepEqual(store.get("memories", ownedMemory.id), ownedMemory);
  assert.equal(
    store.require<{ result: string }>("tasks", "legacy-task").result,
    "An existing result",
  );
  assert.equal(
    store.require<{ objective: string }>("goals", "legacy-goal").objective,
    "Keep this objective",
  );
  assert.equal(
    store.require<{ content: string }>("memories", "legacy-memory").content,
    "Preserve this text",
  );
  assert.equal(
    store.require<{ source: string }>("memories", "legacy-memory").source,
    "User instruction",
  );
  assert.equal(
    store.require<{ read: boolean }>("inbox", "legacy-inbox").read,
    true,
  );
  assert.equal(
    store.require<{ dotId?: string }>("projects", "shared-project").dotId,
    undefined,
  );
  assert.equal(
    store.require<{ dotId?: string }>("models", "shared-model").dotId,
    undefined,
  );
  const migratedTask = store.get("tasks", "legacy-task");
  const migratedMemory = store.get("memories", "task-memory");
  store.close();
  store = open();
  assert.equal(store.count("dots"), 2);
  assert.deepEqual(store.get("tasks", "legacy-task"), migratedTask);
  assert.deepEqual(store.get("memories", "task-memory"), migratedMemory);
});

test("generic store operations cannot remove or demote the primary Dot", (t) => {
  const store = fixture(t).open();
  const primary = store.require<Dot>("dots", PRIMARY_DOT_ID);
  assert.throws(
    () => store.remove("dots", PRIMARY_DOT_ID),
    /primary Dot cannot be removed/,
  );
  assert.throws(
    () => store.update<Dot>("dots", PRIMARY_DOT_ID, { isPrimary: false }),
    /primary status/,
  );
  assert.throws(
    () =>
      store.update<Dot>("dots", PRIMARY_DOT_ID, (record) => {
        record.isPrimary = false;
        return record;
      }),
    /primary status/,
  );
  assert.throws(
    () =>
      store.update<Dot>("dots", PRIMARY_DOT_ID, (record) => {
        const { isPrimary: _removed, ...withoutPrimary } = record;
        return withoutPrimary as Dot;
      }),
    /primary status/,
  );
  assert.throws(
    () => store.put("dots", { ...primary, isPrimary: false }),
    /primary status/,
  );
  assert.throws(
    () =>
      store.compareAndSet("dots", PRIMARY_DOT_ID, primary.version!, {
        ...primary,
        isPrimary: false,
      }),
    /primary status/,
  );
  assert.deepEqual(store.require<Dot>("dots", PRIMARY_DOT_ID), primary);
  const renamed = store.put("dots", {
    ...primary,
    name: "My permanent helper",
  });
  assert.equal(renamed.name, "My permanent helper");
  assert.equal(renamed.isPrimary, true);
});

test("extra Dots can be edited and removed but cannot claim primary status", (t) => {
  const store = fixture(t).open();
  const extra = store.insert<Dot>("dots", {
    name: "Scout",
    personality: "A curious helper",
    avatar: { kind: "dog", color: "#fedcba" },
    isPrimary: false,
    modelProfileId: null,
  });
  assert.throws(
    () =>
      store.insert<Dot>("dots", {
        ...extra,
        id: "another-primary",
        isPrimary: true,
      }),
    /permanent primary/,
  );
  assert.throws(
    () => store.update<Dot>("dots", extra.id, { isPrimary: true }),
    /primary status/,
  );
  assert.throws(
    () => store.put("dots", { ...extra, isPrimary: true }),
    /primary status/,
  );
  assert.equal(
    store.update<Dot>("dots", extra.id, { name: "Rover" }).name,
    "Rover",
  );
  assert.equal(store.remove("dots", extra.id), true);
  assert.equal(store.get("dots", extra.id), undefined);
  assert.ok(store.get("dots", PRIMARY_DOT_ID));
});

test("explicit independent ownership and Dot main conversation links survive repeated restarts", (t) => {
  const { open } = fixture(t);
  let store = open();
  const dot = store.update<Dot>("dots", PRIMARY_DOT_ID, {
    sessionId: "primary-conversation",
  });
  const owned = store.insert("sessions", {
    id: "primary-conversation",
    kind: "dot",
    dotId: PRIMARY_DOT_ID,
    title: "Pip conversation",
  });
  const independent = store.insert("sessions", {
    id: "standalone-chat",
    kind: "chat",
    dotId: null,
    title: "Ordinary conversation",
  });
  const work = store.insert("sessions", {
    id: "standalone-work",
    kind: "work",
    dotId: null,
    title: "Coding session",
  });
  const task = store.insert("tasks", {
    id: "standalone-task",
    sessionId: independent.id,
    dotId: null,
    parentId: null,
  });
  const goal = store.insert("goals", {
    id: "standalone-goal",
    sessionId: work.id,
    dotId: null,
    objective: "Check the project",
  });
  const memory = store.insert("memories", {
    id: "general-memory",
    dotId: null,
    content: "General context",
  });
  const inbox = store.insert("inbox", {
    id: "standalone-result",
    sessionId: independent.id,
    taskId: task.id,
    dotId: null,
    body: "Independent result",
  });
  const expected = [
    ["sessions", independent],
    ["sessions", work],
    ["sessions", owned],
    ["tasks", task],
    ["goals", goal],
    ["memories", memory],
    ["inbox", inbox],
  ] as const;
  for (let restart = 0; restart < 2; restart++) {
    store.close();
    store = open();
    for (const [collection, record] of expected)
      assert.deepEqual(store.get(collection, record.id), record);
    assert.deepEqual(store.require<Dot>("dots", PRIMARY_DOT_ID), dot);
  }
});

test("missing legacy owners inherit independent null while Dot sessions still inherit primary", (t) => {
  const { open } = fixture(t);
  let store = open();
  store.insert("sessions", {
    id: "chat",
    kind: "chat",
    title: "Independent chat",
  });
  store.insert("sessions", {
    id: "work",
    kind: "work",
    title: "Independent work",
  });
  store.insert("sessions", {
    id: "dot",
    kind: "dot",
    title: "Dot conversation",
  });
  store.insert("sessions", { id: "legacy", title: "Before session kinds" });
  store.insert("tasks", { id: "parent", sessionId: "chat", parentId: null });
  store.insert("tasks", { id: "child", sessionId: "dot", parentId: "parent" });
  store.insert("tasks", { id: "work-task", sessionId: "work", parentId: null });
  store.insert("goals", { id: "work-goal", sessionId: "work" });
  store.insert("memories", {
    id: "task-memory",
    taskId: "parent",
    sessionId: "dot",
  });
  store.insert("inbox", {
    id: "task-inbox",
    taskId: "parent",
    sessionId: "dot",
  });
  store.close();
  store = open();
  const independent = [
    ["sessions", "chat"],
    ["sessions", "work"],
    ["tasks", "parent"],
    ["tasks", "child"],
    ["tasks", "work-task"],
    ["goals", "work-goal"],
    ["memories", "task-memory"],
    ["inbox", "task-inbox"],
  ] as const;
  for (const [collection, id] of independent)
    assert.equal(
      store.require<{ dotId: string | null }>(collection, id).dotId,
      null,
    );
  assert.equal(
    store.require<{ dotId: string }>("sessions", "dot").dotId,
    PRIMARY_DOT_ID,
  );
  assert.equal(
    store.require<{ dotId: string }>("sessions", "legacy").dotId,
    PRIMARY_DOT_ID,
  );
  const child = store.get("tasks", "child");
  store.close();
  store = open();
  assert.deepEqual(store.get("tasks", "child"), child);
  for (const [collection, id] of independent)
    assert.equal(
      store.require<{ dotId: string | null }>(collection, id).dotId,
      null,
    );
});

test("removing an extra Dot purges its private audit payloads and occurrences while preserving shared history", (t) => {
  const { open } = fixture(t);
  let store = open();
  const dotId = "dot-deleted";
  // Ownership IDs remain SQL values even if a legacy ID contains punctuation.
  const taskId = "task-deleted'; DELETE FROM audit_events; --";
  const sessionId = "session-deleted";
  const goalId = "goal-deleted";
  const privateData = {
    privatePayload: "Deleted Dot conversation and tool data",
  };
  const removed = [
    store.event("tool.completed", privateData, taskId),
    store.event("message.created", privateData, undefined, sessionId),
    store.event("memory.created", { ...privateData, dotId }),
    store.event("dot.created", { ...privateData, id: dotId }),
    store.event("dot.updated", { ...privateData, id: dotId }),
    store.event("dot.session", { ...privateData, id: dotId }),
    store.event("task.failed", { ...privateData, taskId }),
    store.event("message.created", { ...privateData, sessionId }),
    store.event("goal.triggered", { ...privateData, goalId }),
    store.event("goal.removed", { id: goalId }),
  ];
  const retained = [
    store.event(
      "tool.completed",
      { output: "Another Dot's output" },
      "other-task",
    ),
    store.event(
      "message.created",
      { body: "Independent chat" },
      undefined,
      "independent-session",
    ),
    store.event("memory.created", {
      dotId: "dot-other",
      content: "Other Dot memory",
    }),
    store.event("dot.updated", { id: PRIMARY_DOT_ID, name: "Pip" }),
    store.event("goal.triggered", { goalId: "other-goal" }),
    store.event("model.updated", { id: "shared-model", dotId }),
    store.event("project.updated", { id: "shared-project", taskId }),
    store.event(
      "settings.updated",
      { selectedDotId: dotId },
      taskId,
      sessionId,
    ),
  ];
  const finalPrivateEvent = store.event("task.completed", privateData, taskId);
  const time = "2026-10-07T17:00:00.000Z";
  store.claimOccurrence(goalId, time, "old-owned-task");
  store.claimOccurrence("legacy-owned-goal", time, taskId);
  store.claimOccurrence("other-goal", time, "other-task");
  store.claimOccurrence("independent-goal", time, "independent-task");

  // The caller's record removals and history cleanup share one transaction.
  assert.throws(
    () =>
      store.transaction(() => {
        store.purgeDotHistory(dotId, [taskId], [sessionId], [goalId]);
        throw new Error("Removal rolled back");
      }),
    /Removal rolled back/,
  );
  assert.equal(store.events().length, removed.length + retained.length + 1);
  assert.ok(store.occurrence(goalId, time));
  store.transaction(() => {
    store.purgeDotHistory(dotId, [taskId], [sessionId], [goalId]);
  });
  assert.deepEqual(store.events(), retained);
  assert.equal(store.occurrence(goalId, time), undefined);
  assert.equal(store.occurrence("legacy-owned-goal", time), undefined);
  assert.equal(store.occurrence("other-goal", time)?.taskId, "other-task");
  assert.equal(
    store.occurrence("independent-goal", time)?.taskId,
    "independent-task",
  );

  store.close();
  store = open();
  assert.deepEqual(store.events(), retained);
  const followingEvent = store.event("service.started", { ready: true });
  assert.ok(followingEvent.cursor > finalPrivateEvent.cursor);
  assert.deepEqual(store.events(finalPrivateEvent.cursor), [followingEvent]);
});
