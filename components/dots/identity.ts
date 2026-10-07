import type { Dot, Snapshot } from "@/src/shared/types";

export const PRIMARY_DOT_ID = "dot-primary";

export function ownerId(record: { dotId?: string | null } | null | undefined) {
  return record?.dotId === null ? null : (record?.dotId ?? PRIMARY_DOT_ID);
}

export function independentSnapshot(
  snapshot: Snapshot,
  sessionId?: string,
): Snapshot {
  const tasks = snapshot.tasks.filter(
    (item) =>
      ownerId(item) === null && (!sessionId || item.sessionId === sessionId),
  );
  const taskIds = new Set(tasks.map((task) => task.id));
  return {
    ...snapshot,
    sessions: snapshot.sessions.filter((item) => ownerId(item) === null),
    tasks,
    goals: snapshot.goals.filter((item) => ownerId(item) === null),
    memories: snapshot.memories.filter((item) => ownerId(item) === null),
    inbox: snapshot.inbox.filter(
      (item) =>
        ownerId(item) === null && (!sessionId || item.sessionId === sessionId),
    ),
    approvals: snapshot.approvals.filter((item) => taskIds.has(item.taskId)),
  };
}

export function activeDot(snapshot: Snapshot, owner?: string): Dot | undefined {
  const dots = snapshot.dots ?? [];
  if (owner) return dots.find((dot) => dot.id === owner);
  return (
    dots.find((dot) => dot.id === (owner ?? snapshot.settings.selectedDotId)) ??
    dots.find((dot) => dot.isPrimary) ??
    dots[0]
  );
}

export function dotSnapshot(snapshot: Snapshot, dotId: string): Snapshot {
  const tasks = snapshot.tasks.filter((item) => ownerId(item) === dotId);
  const taskIds = new Set(tasks.map((task) => task.id));
  return {
    ...snapshot,
    sessions: snapshot.sessions.filter((item) => ownerId(item) === dotId),
    tasks,
    goals: snapshot.goals.filter((item) => ownerId(item) === dotId),
    memories: snapshot.memories.filter((item) => ownerId(item) === dotId),
    inbox: snapshot.inbox.filter((item) => ownerId(item) === dotId),
    approvals: snapshot.approvals.filter((item) => taskIds.has(item.taskId)),
    settings: { ...snapshot.settings, selectedDotId: dotId },
  };
}
