import { backup, DatabaseSync } from "node:sqlite";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import {
  controlUrl,
  dataDir,
  loadRuntimeEnv,
  projectRoot,
} from "./runtime-env.mjs";

loadRuntimeEnv();
const args = process.argv.slice(2);
const action = args.shift();
const archiveArg = args.shift();
if (!["backup", "restore"].includes(action) || !archiveArg) {
  throw new Error(
    "Usage: node scripts/state-backup.mjs backup|restore ARCHIVE [--data-dir DIR] [--workflow-dir DIR]",
  );
}
const options = {};
while (args.length) {
  const flag = args.shift();
  if (!["--data-dir", "--workflow-dir"].includes(flag) || !args.length) {
    throw new Error(
      "Supported options are --data-dir DIR and --workflow-dir DIR.",
    );
  }
  options[flag] = resolve(args.shift());
}
const archive = resolve(archiveArg);
const applicationDir = options["--data-dir"] || dataDir();
const workflowDir =
  options["--workflow-dir"] || resolve(projectRoot, ".eve/.workflow-data");

function listening(url) {
  return new Promise((resolveStatus) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    socket.setTimeout(600);
    const finish = (value) => {
      socket.destroy();
      resolveStatus(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function assertOffline() {
  const broker = controlUrl();
  const eve = new URL(process.env.CIT_EVE_URL || "http://127.0.0.1:4319");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(eve.hostname)) {
    throw new Error("Offline backup checks require a loopback Eve URL.");
  }
  if ((await Promise.all([listening(broker), listening(eve)])).some(Boolean)) {
    throw new Error(
      "Stop the broker and Eve worker before backing up or restoring. Their configured ports are still open.",
    );
  }
}

async function runPython(source, pythonArgs) {
  await new Promise((resolveDone, reject) => {
    const child = spawn("python3", ["-c", source, ...pythonArgs], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolveDone()
        : reject(new Error("Archive operation failed.")),
    );
  });
}

function retainCredentialFreeFiles(source) {
  const name = basename(source);
  return !name.startsWith(".env") && name !== "internal-token";
}

async function emptyDestination(path) {
  if (existsSync(path) && (await readdir(path)).length) {
    throw new Error(
      `Restore destination is not empty: ${path}. Move existing state aside first.`,
    );
  }
}

async function copyContents(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of await readdir(source)) {
    await cp(resolve(source, name), resolve(destination, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
  }
}

function checkDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA quick_check").get();
    if (Object.values(result)[0] !== "ok")
      throw new Error("SQLite integrity check failed.");
  } finally {
    db.close();
  }
}

await assertOffline();
const stage = await mkdtemp(resolve(tmpdir(), "cit-dots-state-"));
try {
  if (action === "backup") {
    if (existsSync(archive))
      throw new Error("Archive already exists. Choose a new filename.");
    const sourceDatabase = resolve(applicationDir, "cit.sqlite");
    if (!existsSync(sourceDatabase))
      throw new Error("No application database exists to back up.");
    await mkdir(resolve(stage, "data"), { mode: 0o700 });
    const db = new DatabaseSync(sourceDatabase, { readOnly: true });
    try {
      await backup(db, resolve(stage, "data/cit.sqlite"));
    } finally {
      db.close();
    }
    checkDatabase(resolve(stage, "data/cit.sqlite"));
    const workspaces = resolve(applicationDir, "workspaces");
    if (existsSync(workspaces))
      await cp(workspaces, resolve(stage, "data/workspaces"), {
        recursive: true,
        filter: retainCredentialFreeFiles,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    if (existsSync(workflowDir))
      await cp(workflowDir, resolve(stage, "workflows"), {
        recursive: true,
        filter: retainCredentialFreeFiles,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    await writeFile(
      resolve(stage, "manifest.json"),
      JSON.stringify(
        {
          format: "cit-dots-state-v1",
          createdAt: new Date().toISOString(),
          excludes: [
            ".env*",
            "internal-token",
            "registered source repositories",
            "model weights",
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await mkdir(dirname(archive), { recursive: true, mode: 0o700 });
    await runPython(
      `
import os, sys, tarfile
stage, archive = sys.argv[1:]
os.umask(0o077)
for relative in ('data/workspaces', 'workflows'):
    root = os.path.join(stage, relative)
    if not os.path.exists(root): continue
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = os.path.join(directory, name)
            if os.path.islink(path) and os.path.commonpath((root, os.path.realpath(path))) != root:
                raise ValueError('A state symlink leaves its directory; back up that source repository separately')
created = False
try:
    output = open(archive, 'xb')
    created = True
    with output, tarfile.open(fileobj=output, mode='w:gz') as tar:
        for name in sorted(os.listdir(stage)):
            tar.add(os.path.join(stage, name), arcname=name)
except BaseException:
    if created and os.path.exists(archive): os.unlink(archive)
    raise
`,
      [stage, archive],
    );
    console.log(
      `Backup saved to ${archive}. Runtime credential files and model weights were excluded.`,
    );
  } else {
    await stat(archive);
    await emptyDestination(applicationDir);
    await emptyDestination(workflowDir);
    await runPython(
      `
import posixpath, sys, tarfile
archive, stage = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as tar:
    for member in tar.getmembers():
        name = member.name
        normalized = posixpath.normpath(name)
        if name.startswith('/') or normalized == '..' or normalized.startswith('../'):
            raise ValueError('Archive path escapes the restore directory')
        allowed = normalized in ('data', 'data/cit.sqlite', 'data/workspaces', 'workflows', 'manifest.json') or normalized.startswith(('data/workspaces/', 'workflows/'))
        if not allowed:
            raise ValueError('Unexpected archive entry: ' + name)
        if any(part.startswith('.env') or part == 'internal-token' for part in normalized.split('/')):
            raise ValueError('Archive contains a runtime credential file')
        if not (member.isfile() or member.isdir() or member.issym()):
            raise ValueError('Unsupported archive entry: ' + name)
        if member.issym():
            if not normalized.startswith(('data/workspaces/', 'workflows/')):
                raise ValueError('Archive state roots and metadata must not be symlinks')
            target = posixpath.normpath(posixpath.join(posixpath.dirname(normalized), member.linkname))
            prefix = 'data/workspaces/' if normalized.startswith('data/workspaces/') else 'workflows/'
            if member.linkname.startswith('/') or not target.startswith(prefix):
                raise ValueError('Archive symlink leaves its state directory')
    tar.extractall(stage, filter='data')
`,
      [archive, stage],
    );
    const manifest = JSON.parse(
      await readFile(resolve(stage, "manifest.json"), "utf8"),
    );
    if (manifest.format !== "cit-dots-state-v1")
      throw new Error("Unsupported backup format.");
    checkDatabase(resolve(stage, "data/cit.sqlite"));
    await copyContents(resolve(stage, "data"), applicationDir);
    if (existsSync(resolve(stage, "workflows"))) {
      await copyContents(resolve(stage, "workflows"), workflowDir);
    }
    console.log(
      "Restored application and workflow state. Reconfigure runtime credentials separately.",
    );
    console.log(
      "Keep the tested Eve release and project paths until workflow recovery is verified.",
    );
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
