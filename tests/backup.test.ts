import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Store } from "../src/server/store";
import type { Dot, Session } from "../src/shared/types";

const execute = promisify(execFile);
const script = resolve("scripts/state-backup.mjs");

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady) =>
    server.listen(0, "127.0.0.1", resolveReady),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClosed) =>
    server.close(() => resolveClosed()),
  );
  return port;
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cit-backup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const workflows = join(root, "workflows");
  const bin = join(root, "bin");
  await mkdir(data);
  await mkdir(workflows);
  await mkdir(bin);
  await mkdir(join(data, "workspaces/legacy-task"), { recursive: true });
  await writeFile(
    join(data, "workspaces/legacy-task/result.txt"),
    "Earlier coding output",
  );
  const store = new Store(join(data, "cit.sqlite"));
  const secondary = store.insert<Dot>("dots", {
    id: "dot-secondary",
    name: "Nova",
    personality: "Investigate carefully.",
    avatar: { kind: "cat", color: "#aabbcc" },
    isPrimary: false,
    modelProfileId: null,
  });
  const independent = store.insert<Session>("sessions", {
    title: "Independent chat",
    kind: "chat",
    dotId: null,
    projectId: null,
    modelProfileId: null,
  });
  store.close();
  for (const id of ["dot-primary", secondary.id]) {
    await mkdir(join(data, "dots", id, "computer/home"), { recursive: true });
    await mkdir(join(data, "dots", id, "computer/workspace"), {
      recursive: true,
    });
    await mkdir(join(data, "dots", id, "computer/artifacts"), {
      recursive: true,
    });
    await mkdir(join(data, "dots", id, "computer-state/tasks"), {
      recursive: true,
    });
    await mkdir(join(data, "dots", id, "desktop"), { recursive: true });
    await writeFile(
      join(data, "dots", id, "computer/home/preferences.txt"),
      `Preferences for ${id}`,
    );
    await writeFile(
      join(data, "dots", id, "computer/workspace/program.ts"),
      `export const owner = "${id}";`,
    );
    await writeFile(
      join(data, "dots", id, "computer/artifacts/output.txt"),
      `Output for ${id}`,
    );
    await writeFile(
      join(data, "dots", id, "computer-state/tasks/task.json"),
      '{"status":"completed"}',
    );
    await writeFile(
      join(data, "dots", id, "desktop/metadata.json"),
      '{"password":"private-desktop-secret"}',
    );
    await writeFile(
      join(data, "dots", id, "desktop/vnc-password"),
      "private-desktop-secret",
    );
  }
  await writeFile(join(data, "internal-token"), "private-control-secret");
  await writeFile(
    join(data, "dots/dot-secondary/computer/home/.env"),
    "PRIVATE=secret",
  );
  await symlink(
    "../workspace/program.ts",
    join(data, "dots/dot-secondary/computer/home/program-link"),
  );
  await symlink(
    "..",
    join(data, "dots/dot-secondary/computer/home/computer-root"),
  );
  await writeFile(join(workflows, "run.json"), '{"status":"waiting"}');
  const dockerLog = join(root, "docker-args.json");
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}\n` +
      `const fs = require('node:fs');\n` +
      `fs.writeFileSync(process.env.CIT_BACKUP_DOCKER_LOG, JSON.stringify(process.argv.slice(2)));\n` +
      `if (process.env.CIT_BACKUP_DOCKER_FIXTURE === 'running') process.stdout.write('owned-running-container\\n');\n` +
      `if (process.env.CIT_BACKUP_DOCKER_FIXTURE === 'unavailable') process.exit(1);\n`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CIT_CONTROL_URL: `http://127.0.0.1:${await unusedPort()}`,
    CIT_EVE_URL: `http://127.0.0.1:${await unusedPort()}`,
    CIT_BACKUP_DOCKER_LOG: dockerLog,
    CIT_BACKUP_DOCKER_FIXTURE: "stopped",
  };
  const run = (args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) =>
    execute(process.execPath, [script, ...args], {
      env: { ...env, ...extra },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  return { root, data, workflows, env, run, dockerLog, independent };
}

test("backup restores Dot records, private computers, task metadata and workflows while excluding desktop credentials", async (t) => {
  const f = await fixture(t);
  const archive = join(f.root, "state.tar.gz");
  await f.run([
    "backup",
    archive,
    "--data-dir",
    f.data,
    "--workflow-dir",
    f.workflows,
  ]);
  const restored = join(f.root, "restored-data");
  const restoredWorkflows = join(f.root, "restored-workflows");
  await f.run([
    "restore",
    archive,
    "--data-dir",
    restored,
    "--workflow-dir",
    restoredWorkflows,
  ]);
  const db = new Store(join(restored, "cit.sqlite"));
  try {
    assert.equal(db.get<Dot>("dots", "dot-secondary")?.name, "Nova");
    assert.equal(db.get<Session>("sessions", f.independent.id)?.dotId, null);
  } finally {
    db.close();
  }
  for (const id of ["dot-primary", "dot-secondary"]) {
    assert.equal(
      await readFile(
        join(restored, "dots", id, "computer/home/preferences.txt"),
        "utf8",
      ),
      `Preferences for ${id}`,
    );
    assert.equal(
      await readFile(
        join(restored, "dots", id, "computer/artifacts/output.txt"),
        "utf8",
      ),
      `Output for ${id}`,
    );
    assert.equal(
      await readFile(
        join(restored, "dots", id, "computer-state/tasks/task.json"),
        "utf8",
      ),
      '{"status":"completed"}',
    );
    assert.equal(existsSync(join(restored, "dots", id, "desktop")), false);
  }
  assert.equal(
    await readFile(
      join(restored, "dots/dot-secondary/computer/home/program-link"),
      "utf8",
    ),
    'export const owner = "dot-secondary";',
  );
  assert.equal(
    await readFile(
      join(
        restored,
        "dots/dot-secondary/computer/home/computer-root/artifacts/output.txt",
      ),
      "utf8",
    ),
    "Output for dot-secondary",
  );
  assert.equal(
    await readFile(join(restored, "workspaces/legacy-task/result.txt"), "utf8"),
    "Earlier coding output",
  );
  assert.equal(existsSync(join(restored, "internal-token")), false);
  assert.equal(
    existsSync(join(restored, "dots/dot-secondary/computer/home/.env")),
    false,
  );
  assert.equal(
    await readFile(join(restoredWorkflows, "run.json"), "utf8"),
    '{"status":"waiting"}',
  );
  await assert.rejects(
    f.run([
      "restore",
      archive,
      "--data-dir",
      restored,
      "--workflow-dir",
      restoredWorkflows,
    ]),
    /destination is not empty/,
  );
});

test("backup refuses running owned desktops and cannot assume they stopped when Docker is unavailable", async (t) => {
  const f = await fixture(t);
  const args = [
    "backup",
    join(f.root, "state.tar.gz"),
    "--data-dir",
    f.data,
    "--workflow-dir",
    f.workflows,
  ];
  await assert.rejects(
    f.run(args, { CIT_BACKUP_DOCKER_FIXTURE: "running" }),
    /graphical desktops are still running/,
  );
  const command = JSON.parse(await readFile(f.dockerLog, "utf8")) as string[];
  const owner = createHash("sha256")
    .update(resolve(f.data))
    .digest("hex")
    .slice(0, 24);
  assert.ok(command.includes("label=cit-dots.managed=true"));
  assert.ok(command.includes("label=cit-dots.desktop=true"));
  assert.ok(command.includes(`label=cit-dots.desktop.owner=${owner}`));
  await assert.rejects(
    f.run(args, { CIT_BACKUP_DOCKER_FIXTURE: "unavailable" }),
    /cannot verify/,
  );
  assert.equal(existsSync(join(f.root, "state.tar.gz")), false);
});

test("restore refuses Dot authentication metadata, invalid paths and cross-Dot symlinks before writing destinations", async (t) => {
  const f = await fixture(t);
  const entries = [
    { name: "data/dots/dot-secondary/desktop/metadata.json", target: "" },
    { name: "data/dots/../escaped", target: "" },
    {
      name: "data/dots/dot-primary/computer/home/link",
      target: "../../../dot-secondary/computer/home",
    },
  ];
  for (const [index, entry] of entries.entries()) {
    const archive = join(f.root, `invalid-${index}.tar.gz`);
    await execute("python3", [
      "-c",
      `import io,sys,tarfile\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n i=tarfile.TarInfo(sys.argv[2])\n if sys.argv[3]:\n  i.type=tarfile.SYMTYPE; i.linkname=sys.argv[3]; t.addfile(i)\n else:\n  i.size=1; t.addfile(i,io.BytesIO(b'x'))`,
      archive,
      entry.name,
      entry.target,
    ]);
    const output = join(f.root, `invalid-output-${index}`);
    await assert.rejects(
      f.run([
        "restore",
        archive,
        "--data-dir",
        output,
        "--workflow-dir",
        join(f.root, `invalid-workflow-${index}`),
      ]),
      /Unexpected archive entry|symlink leaves/,
    );
    assert.equal(existsSync(output), false);
  }
  assert.ok((await readdir(f.data)).includes("cit.sqlite"));
});
