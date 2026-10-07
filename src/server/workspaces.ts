import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_PROJECT_BYTES = 512 * 1024 * 1024;
const OMIT = new Set([
  ".git",
  "node_modules",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cit-dots",
]);
const locks = new Map<string, Promise<void>>();

export interface RegisteredProject {
  path: string;
  name: string;
  isGit: boolean;
}
export interface Workspace {
  id: string;
  taskId: string;
  projectPath: string;
  root: string;
  baseline: string;
  metadataPath: string;
  kind: "git" | "copy";
  branch?: string;
  baseCommit?: string;
  createdAt: string;
}
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  binary: boolean;
}
export interface WorkspaceDiff {
  patch: string;
  files: ChangedFile[];
  truncated: boolean;
}

/** Serialize commands and file tools, so an agent cannot race its own path checks. */
export async function withWorkspaceLock<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(root, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(root) === queued) locks.delete(root);
  }
}

function assertRelative(relative: string, allowRoot = false) {
  if (
    typeof relative !== "string" ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    relative.includes("\\")
  )
    throw new Error("Use a relative workspace path.");
  const parts = relative.split("/");
  if (
    (!relative && !allowRoot) ||
    parts.some(
      (part) => part === ".." || part === ".git" || part === ".cit-dots",
    )
  )
    throw new Error("Path escapes workspace or targets protected metadata.");
}

/** No existing component may be a symlink; final opens also use O_NOFOLLOW. */
export async function safePath(
  root: string,
  relative: string,
  allowMissing = false,
): Promise<string> {
  assertRelative(relative, true);
  const canonical = await fs.realpath(root);
  if (canonical !== path.resolve(root))
    throw new Error("Workspace root cannot be a symlink.");
  const target = path.resolve(canonical, relative);
  if (target !== canonical && !target.startsWith(`${canonical}${path.sep}`))
    throw new Error("Path escapes workspace.");
  let cursor = canonical;
  for (const part of path
    .relative(canonical, target)
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink())
        throw new Error("Symlink traversal is not permitted.");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
        break;
      throw error;
    }
  }
  return target;
}

export async function registerProject(
  input: string,
): Promise<RegisteredProject> {
  if (!input || !path.isAbsolute(input))
    throw new Error("Project path must be absolute.");
  const canonical = await fs.realpath(input);
  if (!(await fs.stat(canonical)).isDirectory())
    throw new Error("Project must be a directory.");
  // Registering / or a home directory would accidentally expose unrelated data.
  if (canonical === path.parse(canonical).root)
    throw new Error("Register a project folder, not the filesystem root.");
  let isGit = false;
  try {
    const { stdout } = await exec(
      "git",
      ["-C", canonical, "rev-parse", "--show-toplevel"],
      { timeout: 5000 },
    );
    isGit = (await fs.realpath(stdout.trim())) === canonical;
  } catch {
    /* A plain directory is supported. */
  }
  return { path: canonical, name: path.basename(canonical), isGit };
}

async function copyProject(source: string, target: string) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  let files = 0,
    bytes = 0;
  async function visit(relative: string) {
    const entries = await fs.readdir(path.join(source, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (OMIT.has(entry.name) || entry.isSymbolicLink()) continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(path.join(target, child), { recursive: true });
        await visit(child);
      } else if (entry.isFile()) {
        const from = await safePath(source, child);
        const info = await fs.stat(from);
        files++;
        bytes += info.size;
        if (files > MAX_FILES || bytes > MAX_PROJECT_BYTES)
          throw new Error(
            "Project exceeds snapshot limit. Exclude large generated files.",
          );
        const input = await fs.open(
          from,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const output = await fs.open(
            path.join(target, child),
            constants.O_CREAT |
              constants.O_WRONLY |
              constants.O_TRUNC |
              constants.O_NOFOLLOW,
            info.mode & 0o777,
          );
          try {
            await output.writeFile(await input.readFile());
          } finally {
            await output.close();
          }
        } finally {
          await input.close();
        }
      }
    }
  }
  await visit("");
}

/** The baseline includes the user's dirty checkout, without modifying that checkout. */
export async function createWorkspace(
  projectPath: string,
  taskId: string,
  dataDir: string,
): Promise<Workspace> {
  const project = await registerProject(projectPath);
  const id = randomUUID();
  const directory = path.resolve(dataDir, "workspaces", id);
  if (directory.startsWith(`${project.path}${path.sep}`))
    throw new Error(
      "Workspace storage must be outside the registered project.",
    );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const root = path.join(directory, "project"),
    baseline = path.join(directory, "baseline");
  const workspace: Workspace = {
    id,
    taskId,
    projectPath: project.path,
    root,
    baseline,
    metadataPath: path.join(directory, "workspace.json"),
    kind: "copy",
    createdAt: new Date().toISOString(),
  };
  try {
    await copyProject(project.path, baseline);
    if (project.isGit) {
      try {
        const { stdout } = await exec(
          "git",
          ["-C", project.path, "rev-parse", "--verify", "HEAD"],
          { timeout: 5000 },
        );
        workspace.baseCommit = stdout.trim();
      } catch {
        /* Unborn repositories use an isolated copy. */
      }
      if (workspace.baseCommit) {
        workspace.branch = `cit-dots/${id}`;
        // Git metadata lives inside the task mount. --no-local uses Git transport
        // rather than copying alternates or sharing object files with the source.
        await exec(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "clone",
            "--no-local",
            "--no-hardlinks",
            "--no-checkout",
            "--",
            project.path,
            root,
          ],
          { timeout: 60_000 },
        );
        await exec(
          "git",
          [
            "-C",
            root,
            "-c",
            "core.hooksPath=/dev/null",
            "checkout",
            "-b",
            workspace.branch,
            workspace.baseCommit,
          ],
          { timeout: 30_000 },
        );
        await exec("git", ["-C", root, "remote", "remove", "origin"], {
          timeout: 5000,
        });
        await exec(
          "git",
          ["-C", root, "config", "core.hooksPath", "/dev/null"],
          { timeout: 5000 },
        );
        workspace.kind = "git";
        // Replace checked-out files with the exact dirty snapshot. The clone's
        // index stays at baseCommit, so ordinary git status/diff work in Docker.
        for (const entry of await fs.readdir(root))
          if (entry !== ".git")
            await fs.rm(path.join(root, entry), {
              recursive: true,
              force: true,
            });
      }
    }
    await copyProject(baseline, root);
    await fs.writeFile(
      workspace.metadataPath,
      JSON.stringify(workspace, null, 2),
      { mode: 0o600 },
    );
    return workspace;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function loadWorkspace(metadataPath: string): Promise<Workspace> {
  const workspace = JSON.parse(
    await fs.readFile(metadataPath, "utf8"),
  ) as Workspace;
  if (
    workspace.metadataPath !== metadataPath ||
    path.dirname(workspace.root) !== path.dirname(metadataPath) ||
    path.dirname(workspace.baseline) !== path.dirname(metadataPath)
  )
    throw new Error("Invalid workspace metadata.");
  await safePath(workspace.root, "");
  await safePath(workspace.baseline, "");
  return workspace;
}

export async function listFiles(
  workspace: Workspace,
  relative = "",
): Promise<{ path: string; type: "file" | "directory"; size: number }[]> {
  return withWorkspaceLock(workspace.root, async () => {
    const directory = await safePath(workspace.root, relative);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_FILES)
      throw new Error("Directory contains too many entries.");
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        OMIT.has(entry.name) ||
        entry.isSymbolicLink() ||
        (!entry.isFile() && !entry.isDirectory())
      )
        continue;
      const file = await safePath(
        workspace.root,
        path.join(relative, entry.name),
      );
      result.push({
        path: path.posix.join(relative, entry.name),
        type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        size: (await fs.stat(file)).size,
      });
    }
    return result;
  });
}

export async function readFile(
  workspace: Workspace,
  relative: string,
): Promise<string> {
  assertRelative(relative);
  return withWorkspaceLock(workspace.root, async () => {
    const handle = await fs.open(
      await safePath(workspace.root, relative),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE)
        throw new Error("Read accepts regular files up to 2 MiB.");
      const content = await handle.readFile();
      if (content.includes(0))
        throw new Error("Binary file cannot be read as text.");
      return content.toString("utf8");
    } finally {
      await handle.close();
    }
  });
}

export async function writeFile(
  workspace: Workspace,
  relative: string,
  content: string,
): Promise<void> {
  assertRelative(relative);
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE)
    throw new Error("Write accepts text up to 2 MiB.");
  return withWorkspaceLock(workspace.root, async () => {
    const target = await safePath(workspace.root, relative, true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await safePath(workspace.root, relative, true);
    const handle = await fs.open(
      target,
      constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  });
}

type SnapshotFile = {
  hash: string;
  mode: number;
  binary: boolean;
  size: number;
};
async function snapshot(root: string): Promise<Map<string, SnapshotFile>> {
  const result = new Map<string, SnapshotFile>();
  let bytes = 0;
  async function visit(relative: string) {
    for (const entry of await fs.readdir(await safePath(root, relative), {
      withFileTypes: true,
    })) {
      if (OMIT.has(entry.name)) continue;
      const child = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Symlink in workspace: ${child}. Remove it before reviewing or applying changes.`,
        );
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const handle = await fs.open(
          await safePath(root, child),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          bytes += stat.size;
          if (result.size >= MAX_FILES || bytes > MAX_PROJECT_BYTES)
            throw new Error("Workspace exceeds review limit.");
          const content = await handle.readFile();
          result.set(child, {
            hash: createHash("sha256").update(content).digest("hex"),
            mode: stat.mode & 0o777,
            binary: content.includes(0),
            size: content.length,
          });
        } finally {
          await handle.close();
        }
      } else throw new Error(`Special file in workspace: ${child}.`);
    }
  }
  await visit("");
  return result;
}

async function changes(workspace: Workspace) {
  const [before, after] = await Promise.all([
    snapshot(workspace.baseline),
    snapshot(workspace.root),
  ]);
  const files: ChangedFile[] = [];
  for (const relative of [
    ...new Set([...before.keys(), ...after.keys()]),
  ].sort()) {
    const old = before.get(relative),
      current = after.get(relative);
    if (old?.hash === current?.hash && old?.mode === current?.mode) continue;
    files.push({
      path: relative,
      status: !old ? "added" : !current ? "deleted" : "modified",
      binary: Boolean(old?.binary || current?.binary),
    });
  }
  return { files, before, after };
}

async function atomicWrite(
  root: string,
  relative: string,
  content: Buffer,
  mode: number,
) {
  const target = await safePath(root, relative, true);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await safePath(root, relative, true);
  const temporary = path.join(
    path.dirname(target),
    `.cit-stage-${randomUUID()}`,
  );
  try {
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await safePath(root, relative, true);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function workspaceDiff(
  workspace: Workspace,
): Promise<WorkspaceDiff> {
  return withWorkspaceLock(workspace.root, async () => {
    const { files } = await changes(workspace);
    let patch = "",
      truncated = false;
    for (const file of files) {
      const oldFile =
        file.status === "added"
          ? "/dev/null"
          : await safePath(workspace.baseline, file.path);
      const newFile =
        file.status === "deleted"
          ? "/dev/null"
          : await safePath(workspace.root, file.path);
      let diff = "";
      try {
        const result = await exec(
          "git",
          [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--binary",
            "--",
            oldFile,
            newFile,
          ],
          { maxBuffer: 4 * MAX_FILE },
        );
        diff = result.stdout;
      } catch (error) {
        const failure = error as { code?: number; stdout?: string };
        if (failure.code !== 1) throw error;
        diff = failure.stdout ?? "";
      }
      diff = diff
        .replaceAll(workspace.baseline + "/", "")
        .replaceAll(workspace.root + "/", "");
      if (Buffer.byteLength(patch + diff) > 4 * MAX_FILE) {
        truncated = true;
        break;
      }
      patch += diff;
    }
    return { patch, files, truncated };
  });
}

/** All destination hashes are checked before writes. Existing unrelated edits are preserved. */
export async function applyWorkspace(
  workspace: Workspace,
): Promise<{ files: string[] }> {
  return withWorkspaceLock(workspace.root, async () => {
    const canonical = await fs.realpath(workspace.projectPath);
    if (canonical !== workspace.projectPath)
      throw new Error("Project location changed.");
    const { files, before, after } = await changes(workspace);
    const saved = new Map<string, { content: Buffer; mode: number } | null>();
    const replacements = new Map<string, Buffer>();
    for (const file of files) {
      const target = await safePath(canonical, file.path, true);
      let actual: Buffer | null = null,
        mode = 0o644;
      try {
        const handle = await fs.open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile())
            throw new Error("Destination is not a regular file.");
          mode = stat.mode & 0o777;
          actual = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const expected = before.get(file.path);
      const hash =
        actual === null
          ? undefined
          : createHash("sha256").update(actual).digest("hex");
      if (hash !== expected?.hash || (expected && mode !== expected.mode))
        throw new Error(
          `Conflict: ${file.path} changed in the original project. No changes applied.`,
        );
      saved.set(file.path, actual === null ? null : { content: actual, mode });
      if (file.status !== "deleted")
        replacements.set(
          file.path,
          await fs.readFile(await safePath(workspace.root, file.path)),
        );
    }
    const applied: string[] = [];
    try {
      for (const file of files) {
        const target = await safePath(canonical, file.path, true);
        if (file.status === "deleted") await fs.unlink(target);
        else
          await atomicWrite(
            canonical,
            file.path,
            replacements.get(file.path)!,
            after.get(file.path)!.mode,
          );
        applied.push(file.path);
      }
    } catch (error) {
      // Recover already-written files when a filesystem error interrupts application.
      for (const relative of applied.reverse()) {
        const target = await safePath(canonical, relative, true),
          previous = saved.get(relative);
        if (previous)
          await atomicWrite(
            canonical,
            relative,
            previous.content,
            previous.mode,
          );
        else await fs.rm(target, { force: true });
      }
      throw error;
    }
    return { files: files.map((file) => file.path) };
  });
}

export async function exportPatch(workspace: Workspace): Promise<string> {
  const diff = await workspaceDiff(workspace);
  if (diff.truncated) throw new Error("Patch exceeds export limit.");
  return diff.patch;
}

export async function removeWorkspace(workspace: Workspace): Promise<void> {
  return withWorkspaceLock(workspace.root, async () => {
    // Clean up pre-clone workspaces too, if a development database retained one.
    if (
      workspace.kind === "git" &&
      (await fs.lstat(path.join(workspace.root, ".git"))).isFile()
    )
      await exec(
        "git",
        [
          "-C",
          workspace.projectPath,
          "worktree",
          "remove",
          "--force",
          workspace.root,
        ],
        { timeout: 30_000 },
      );
    await fs.rm(path.dirname(workspace.metadataPath), {
      recursive: true,
      force: true,
    });
  });
}
