import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createWorkspace,
  writeFile,
  readFile,
  listFiles,
  workspaceDiff,
  applyWorkspace,
  registerProject,
  removeWorkspace,
} from "../src/server/workspaces";
import { runCommand, commandHash, inspectCommand } from "../src/server/runner";

const exec = promisify(execFile);
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cit-workspaces-"));
  const project = path.join(directory, "source"),
    data = path.join(directory, "data");
  await fs.mkdir(project);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, project, data };
}

test("independent Git clone includes dirty state, preserves source refs and applies conflict-free changes", async (t) => {
  const { project, data } = await fixture(t);
  await exec("git", ["init", project]);
  await fs.writeFile(path.join(project, "app.txt"), "original\n");
  await exec("git", ["-C", project, "add", "app.txt"]);
  await exec("git", [
    "-C",
    project,
    "-c",
    "user.name=Tests",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "initial",
  ]);
  await fs.writeFile(path.join(project, "app.txt"), "user dirty edit\n");
  await fs.writeFile(path.join(project, "notes.txt"), "untracked notes\n");
  const sourceRefs = (await exec("git", ["-C", project, "show-ref"])).stdout;
  const sourceWorktrees = (
    await exec("git", ["-C", project, "worktree", "list", "--porcelain"])
  ).stdout;
  const workspace = await createWorkspace(project, "task-git", data);
  assert.equal(workspace.kind, "git");
  assert.equal(
    (await fs.lstat(path.join(workspace.root, ".git"))).isDirectory(),
    true,
  );
  assert.equal(
    (await exec("git", ["-C", project, "show-ref"])).stdout,
    sourceRefs,
  );
  assert.equal(
    (await exec("git", ["-C", project, "worktree", "list", "--porcelain"]))
      .stdout,
    sourceWorktrees,
  );
  assert.equal(
    (await exec("git", ["-C", workspace.root, "remote"])).stdout,
    "",
  );
  await assert.rejects(
    fs.access(
      path.join(workspace.root, ".git", "objects", "info", "alternates"),
    ),
  );
  assert.equal(await readFile(workspace, "app.txt"), "user dirty edit\n");
  assert.equal(await readFile(workspace, "notes.txt"), "untracked notes\n");
  await writeFile(workspace, "app.txt", "user dirty edit\nagent improvement\n");
  await writeFile(workspace, "new.txt", "new agent file\n");
  assert.equal(
    await fs.readFile(path.join(project, "app.txt"), "utf8"),
    "user dirty edit\n",
  );
  const diff = await workspaceDiff(workspace);
  assert.deepEqual(
    diff.files.map((file) => file.path),
    ["app.txt", "new.txt"],
  );
  assert.match(diff.patch, /agent improvement/);
  assert.doesNotMatch(diff.patch, new RegExp(workspace.root));
  await fs.writeFile(path.join(project, "notes.txt"), "later unrelated edit\n");
  await applyWorkspace(workspace);
  assert.equal(
    await fs.readFile(path.join(project, "app.txt"), "utf8"),
    "user dirty edit\nagent improvement\n",
  );
  assert.equal(
    await fs.readFile(path.join(project, "notes.txt"), "utf8"),
    "later unrelated edit\n",
  );
  await removeWorkspace(workspace);
});

test("apply preflights all destination conflicts before modifying any file", async (t) => {
  const { project, data } = await fixture(t);
  await fs.writeFile(path.join(project, "a.txt"), "A");
  await fs.writeFile(path.join(project, "z.txt"), "Z");
  const workspace = await createWorkspace(project, "task-conflict", data);
  await writeFile(workspace, "a.txt", "agent A");
  await writeFile(workspace, "z.txt", "agent Z");
  await fs.writeFile(path.join(project, "z.txt"), "user Z");
  await assert.rejects(applyWorkspace(workspace), /Conflict: z.txt/);
  assert.equal(await fs.readFile(path.join(project, "a.txt"), "utf8"), "A");
  assert.equal(
    await fs.readFile(path.join(project, "z.txt"), "utf8"),
    "user Z",
  );
});

test("unborn git repositories use an isolated copy without making a commit", async (t) => {
  const { project, data } = await fixture(t);
  await exec("git", ["init", project]);
  await fs.writeFile(path.join(project, "first.py"), "print(1)\n");
  const workspace = await createWorkspace(project, "task-unborn", data);
  assert.equal(workspace.kind, "copy");
  await writeFile(workspace, "first.py", "print(2)\n");
  assert.equal(
    await fs.readFile(path.join(project, "first.py"), "utf8"),
    "print(1)\n",
  );
  await assert.rejects(
    exec("git", ["-C", project, "rev-parse", "--verify", "HEAD"]),
  );
});

test("file tools reject escapes, metadata paths, binary files and symlink traversal", async (t) => {
  const { directory, project, data } = await fixture(t);
  const outside = path.join(directory, "outside.txt");
  await fs.writeFile(outside, "private");
  await fs.writeFile(path.join(project, "safe.txt"), "safe");
  const workspace = await createWorkspace(project, "task-safe", data);
  await fs.symlink(outside, path.join(workspace.root, "link.txt"));
  await fs.symlink(directory, path.join(workspace.root, "escape"));
  await fs.writeFile(
    path.join(workspace.root, "binary.bin"),
    Buffer.from([0, 1, 2]),
  );
  await assert.rejects(readFile(workspace, "../outside.txt"), /escapes/);
  await assert.rejects(
    writeFile(workspace, "escape/outside.txt", "overwrite"),
    /Symlink/,
  );
  await assert.rejects(readFile(workspace, "link.txt"), /Symlink/);
  await assert.rejects(
    writeFile(workspace, ".git/config", "overwrite"),
    /metadata/,
  );
  await assert.rejects(readFile(workspace, "binary.bin"), /Binary/);
  await assert.rejects(workspaceDiff(workspace), /Symlink/);
  assert.equal(await fs.readFile(outside, "utf8"), "private");
  assert.deepEqual(
    (await listFiles(workspace)).map((entry) => entry.path),
    ["binary.bin", "safe.txt"],
  );
});

test("project registration canonicalizes a symlink and rejects filesystem root", async (t) => {
  const { directory, project } = await fixture(t);
  await fs.symlink(project, path.join(directory, "alias"));
  assert.equal(
    (await registerProject(path.join(directory, "alias"))).path,
    project,
  );
  await assert.rejects(registerProject("/"), /filesystem root/);
});

test("network approval is bound to the exact command, operation, and task", async (t) => {
  const { project, data } = await fixture(t);
  const workspace = await createWorkspace(project, "task-network", data);
  await assert.rejects(
    runCommand({
      workspace,
      command: "true",
      operationId: "op-1",
      networkApproval: {
        approvalId: "approval",
        operationId: "op-2",
        taskId: workspace.taskId,
        commandHash: commandHash("true"),
      },
    }),
    /must match/,
  );
  await assert.rejects(
    runCommand({
      workspace,
      command: "false",
      operationId: "op-1",
      networkApproval: {
        approvalId: "approval",
        operationId: "op-1",
        taskId: workspace.taskId,
        commandHash: commandHash("true"),
      },
    }),
    /must match/,
  );
});

const sandboxTest = process.env.CIT_TEST_DOCKER === "1" ? test : test.skip;
sandboxTest(
  "real Docker git status/diff use independent task metadata without modifying the source",
  async (t) => {
    const { project, data } = await fixture(t);
    await exec("git", ["init", project]);
    await fs.writeFile(path.join(project, "main.py"), "print(1)\n");
    await exec("git", ["-C", project, "add", "main.py"]);
    await exec("git", [
      "-C",
      project,
      "-c",
      "user.name=Tests",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "initial",
    ]);
    const originalHead = (
      await exec("git", ["-C", project, "rev-parse", "HEAD"])
    ).stdout;
    const workspace = await createWorkspace(project, "task-git-docker", data);
    await writeFile(workspace, "main.py", "print(2)\n");
    const result = await runCommand({
      workspace,
      command:
        "git status --short && git diff -- main.py && test -d .git && test ! -e .git/objects/info/alternates",
      operationId: "docker-git",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /M main.py/);
    assert.match(result.stdout, /\+print\(2\)/);
    assert.equal(
      (await exec("git", ["-C", project, "rev-parse", "HEAD"])).stdout,
      originalHead,
    );
    assert.equal(
      await fs.readFile(path.join(project, "main.py"), "utf8"),
      "print(1)\n",
    );
  },
);

sandboxTest(
  "real Docker executes workspace code, denies host access/network and preserves exit status",
  async (t) => {
    const { project, data } = await fixture(t);
    await fs.writeFile(
      path.join(project, "test.py"),
      'print("actual test result")\n',
    );
    const workspace = await createWorkspace(project, "task-docker", data);
    const result = await runCommand({
      workspace,
      command:
        "python3 test.py && node --version && test ! -e /var/run/docker.sock && test ! -e /workspace/../baseline && exit 7",
      operationId: "docker-exit",
    });
    assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /actual test result/);
    assert.match(result.stdout, /v24\./);
    assert.equal(result.canceled, false);
    const isolation = await runCommand({
      workspace,
      command:
        "python3 -c 'import socket; s=socket.socket(); s.settimeout(1); s.connect((\"1.1.1.1\",443))'",
      operationId: "docker-network",
    });
    assert.notEqual(isolation.exitCode, 0);
  },
);

sandboxTest(
  "real Docker command timeout and cancellation remove the container",
  async (t) => {
    const { project, data } = await fixture(t);
    const workspace = await createWorkspace(project, "task-stop", data);
    const timed = await runCommand({
      workspace,
      command: "sleep 30",
      operationId: "docker-timeout",
      timeoutMs: 500,
    });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.exitCode, 124);
    assert.equal((await inspectCommand("docker-timeout")).state, "missing");
    const controller = new AbortController();
    const pending = runCommand({
      workspace,
      command: "sleep 30",
      operationId: "docker-cancel",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500);
    const canceled = await pending;
    assert.equal(canceled.canceled, true);
    assert.equal(canceled.exitCode, 130);
    assert.equal((await inspectCommand("docker-cancel")).state, "missing");
  },
);
