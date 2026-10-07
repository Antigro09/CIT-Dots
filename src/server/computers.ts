import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspaces";

export interface Computer {
  dotId: string;
  root: string;
  home: string;
  workspace: string;
  artifacts: string;
}

export function computerUser(): { uid: number; gid: number } {
  const uid = process.getuid?.() ?? 1000;
  return {
    uid: uid === 0 ? 1000 : uid,
    gid: uid === 0 ? 1000 : (process.getgid?.() ?? 1000),
  };
}

function boundedId(id: string, kind: string) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id))
    throw new Error(`Invalid ${kind} ID.`);
}

/** Inspect every parent first: mkdir must never follow a guest-created symlink. */
async function privateDirectory(directory: string, guestOwned = false) {
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const segment of path
    .relative(cursor, absolute)
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const info = await fs.lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(
          "Computer storage parents must be real directories, not symlinks.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.mkdir(cursor, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
          throw mkdirError;
      }
      const created = await fs.lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink())
        throw new Error(
          "Computer storage changed while creating its directories.",
        );
    }
  }
  await fs.chmod(absolute, 0o700);
  if (guestOwned && process.getuid?.() === 0) {
    const { uid, gid } = computerUser();
    await fs.chown(absolute, uid, gid);
  }
  if ((await fs.realpath(absolute)) !== absolute)
    throw new Error("Computer storage must have canonical paths.");
}

/** The broker supplies dataDir and a stored Dot ID; model input never supplies mounts. */
export async function ensureComputer(
  dataDir: string,
  dotId: string,
): Promise<Computer> {
  boundedId(dotId, "Dot");
  const base = path.resolve(dataDir);
  if (base === path.parse(base).root)
    throw new Error("Computer data storage cannot be the filesystem root.");
  await privateDirectory(base);
  await privateDirectory(path.join(base, "dots"));
  await privateDirectory(path.join(base, "dots", dotId));
  const root = path.join(base, "dots", dotId, "computer");
  await privateDirectory(root, true);
  const computer = {
    dotId,
    root,
    home: path.join(root, "home"),
    workspace: path.join(root, "workspace"),
    artifacts: path.join(root, "artifacts"),
  };
  for (const directory of [
    computer.home,
    computer.workspace,
    computer.artifacts,
  ])
    await privateDirectory(directory, true);
  return computer;
}

export async function createComputerWorkspace(
  dataDir: string,
  dotId: string,
  taskId: string,
): Promise<Workspace> {
  boundedId(taskId, "task");
  const computer = await ensureComputer(dataDir, dotId);
  const state = path.join(path.dirname(computer.root), "computer-state");
  await privateDirectory(state);
  const baseline = path.join(state, "baseline");
  await privateDirectory(baseline);
  const taskState = path.join(state, "tasks");
  await privateDirectory(taskState);
  const metadataPath = path.join(taskState, `${taskId}.json`);
  const workspace: Workspace = {
    id: `computer-${dotId}-${taskId}`,
    taskId,
    projectPath: computer.workspace,
    root: computer.workspace,
    baseline,
    metadataPath,
    kind: "copy",
    scope: "computer",
    dotId,
    computerRoot: computer.root,
    createdAt: new Date().toISOString(),
  };
  // Metadata stays outside all guest mounts; don't overwrite an unexpected link.
  const handle = await fs.open(
    metadataPath,
    constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(workspace, null, 2));
  } finally {
    await handle.close();
  }
  return workspace;
}

/** Attach an approved project clone to its owner's persistent computer. */
export async function attachComputer(
  workspace: Workspace,
  dataDir: string,
  dotId: string,
): Promise<Workspace> {
  if (workspace.dotId && workspace.dotId !== dotId)
    throw new Error("Workspace belongs to a different Dot.");
  const computer = await ensureComputer(dataDir, dotId);
  if (workspace.scope === "computer" && workspace.root !== computer.workspace)
    throw new Error("Computer workspace ownership mismatch.");
  // In a root-run service the guest still uses uid1000. Change only the isolated
  // clone's ownership; baseline and original project are never mounted or chowned.
  if (process.getuid?.() === 0 && workspace.scope !== "computer") {
    const { uid, gid } = computerUser();
    async function own(directory: string) {
      const info = await fs.lstat(directory);
      if (info.isSymbolicLink()) return;
      await fs.chown(directory, uid, gid);
      if (info.isDirectory())
        for (const entry of await fs.readdir(directory))
          await own(path.join(directory, entry));
    }
    await own(workspace.root);
  }
  return {
    ...workspace,
    scope: workspace.scope ?? "project",
    dotId,
    computerRoot: computer.root,
  };
}
