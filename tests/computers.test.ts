import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachComputer,
  createComputerWorkspace,
  ensureComputer,
  computerUser,
} from "../src/server/computers";
import {
  applyWorkspace,
  createWorkspace,
  listFiles,
  loadWorkspace,
  readFile,
  removeWorkspace,
  withWorkspaceLock,
  writeFile,
  workspaceDiff,
} from "../src/server/workspaces";
import {
  runCommand,
  runDesktopCommand,
  cancelDesktopCommand,
} from "../src/server/runner";
import { DesktopManager } from "../src/server/desktops";

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cit-computers-"));
  const data = path.join(directory, "data");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, data };
}

test("each Dot gets private computer directories and persistence across tasks", async (t) => {
  const { data } = await fixture(t);
  const primary = await ensureComputer(data, "dot-primary");
  const other = await ensureComputer(data, "dot-other");
  assert.notEqual(primary.root, other.root);
  for (const computer of [primary, other]) {
    for (const directory of [
      computer.root,
      computer.home,
      computer.workspace,
      computer.artifacts,
    ])
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  }
  const first = await createComputerWorkspace(
    data,
    "dot-primary",
    "task-first",
  );
  await writeFile(first, "notes.txt", "persistent working notes");
  await removeWorkspace(first);
  const next = await createComputerWorkspace(data, "dot-primary", "task-next");
  assert.equal(await readFile(next, "notes.txt"), "persistent working notes");
  assert.equal(
    (await loadWorkspace(next.metadataPath)).root,
    primary.workspace,
  );
  assert.equal(
    (
      await listFiles(
        await createComputerWorkspace(data, "dot-other", "other-task"),
      )
    ).length,
    0,
  );
  assert.equal(next.scope, "computer");
  assert.equal(next.kind, "copy");
  assert.deepEqual((await workspaceDiff(next)).files, []);
  await assert.rejects(applyWorkspace(next), /private computer/);
  assert.equal(next.metadataPath.startsWith(primary.root + path.sep), false);
});

test("computer roots reject invalid IDs and symlinked parents without modifying targets", async (t) => {
  const { directory, data } = await fixture(t);
  for (const id of ["../escape", "/absolute", "dot/bad", "", "dot\\bad"])
    await assert.rejects(ensureComputer(data, id), /Invalid Dot/);
  const outside = path.join(directory, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.txt"), "untouched");
  await fs.mkdir(data);
  await fs.symlink(outside, path.join(data, "dots"));
  await assert.rejects(ensureComputer(data, "dot-primary"), /symlink/);
  assert.equal(
    await fs.readFile(path.join(outside, "private.txt"), "utf8"),
    "untouched",
  );
  await assert.rejects(ensureComputer("/", "dot-primary"), /filesystem root/);
});

test("guest-created home symlinks and conflicting Dot ownership are refused", async (t) => {
  const { directory, data } = await fixture(t);
  const computer = await ensureComputer(data, "dot-first");
  await fs.rmdir(computer.home);
  await fs.symlink(directory, computer.home);
  await assert.rejects(ensureComputer(data, "dot-first"), /symlink/);
  const other = await createComputerWorkspace(data, "dot-other", "task-other");
  await assert.rejects(attachComputer(other, data, "dot-new"), /different Dot/);
});

test("all workspace file operations use the owning Dot's common computer lock", async (t) => {
  const { data } = await fixture(t);
  const first = await createComputerWorkspace(data, "dot-first", "task-one");
  const same = await createComputerWorkspace(data, "dot-first", "task-two");
  const other = await createComputerWorkspace(data, "dot-other", "task-three");
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const held = withWorkspaceLock(first.computerRoot!, () => gate);
  let sameFinished = false;
  const pending = writeFile(same, "shared.txt", "after unlock").then(() => {
    sameFinished = true;
  });
  await writeFile(other, "independent.txt", "other Dot runs");
  assert.equal(sameFinished, false);
  unlock();
  await Promise.all([held, pending]);
  assert.equal(await readFile(first, "shared.txt"), "after unlock");
});

test("approved project workspaces attach Dot HOME without changing diff/apply behavior", async (t) => {
  const { directory, data } = await fixture(t);
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "main.txt"), "before");
  const workspace = await attachComputer(
    await createWorkspace(project, "task-project", data),
    data,
    "dot-primary",
  );
  assert.equal(workspace.scope, "project");
  assert.equal(workspace.dotId, "dot-primary");
  assert.notEqual(
    workspace.root,
    path.join(workspace.computerRoot!, "workspace"),
  );
  await writeFile(workspace, "main.txt", "after");
  assert.deepEqual(
    (await workspaceDiff(workspace)).files.map((file) => file.path),
    ["main.txt"],
  );
  await applyWorkspace(workspace);
  assert.equal(
    await fs.readFile(path.join(project, "main.txt"), "utf8"),
    "after",
  );
  assert.equal(computerUser().uid > 0, true);
});

const dockerTest = process.env.CIT_TEST_DOCKER === "1" ? test : test.skip;
dockerTest(
  "real Docker persists a Dot's home/artifacts and never mounts another Dot or metadata",
  async (t) => {
    const { data } = await fixture(t);
    const first = await createComputerWorkspace(
      data,
      "dot-first",
      "task-docker-one",
    );
    const other = await createComputerWorkspace(
      data,
      "dot-other",
      "task-docker-two",
    );
    await writeFile(other, "private.txt", "other Dot secret");
    const created = await runCommand({
      workspace: first,
      operationId: `${data}:dot-computer-create`,
      command:
        'printf "persistent-home" > "$HOME/state.txt"; printf "artifact" > "$CIT_ARTIFACTS_DIR/result.txt"; printf "workspace" > /workspace/work.txt; test "$HOME" = /home/cit; test "$(id -u)" != 0; test ! -e /computer/../computer-state; test ! -e /workspace/private.txt; test ! -e /var/run/docker.sock',
    });
    assert.equal(created.exitCode, 0, created.stderr);
    const next = await createComputerWorkspace(
      data,
      "dot-first",
      "task-docker-next",
    );
    const recovered = await runCommand({
      workspace: next,
      operationId: `${data}:dot-computer-recover`,
      command:
        'cat "$HOME/state.txt"; cat "$CIT_ARTIFACTS_DIR/result.txt"; cat /workspace/work.txt',
    });
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert.equal(recovered.stdout, "persistent-homeartifactworkspace");
    assert.equal(await readFile(other, "private.txt"), "other Dot secret");
    const wrong = { ...other, computerRoot: first.computerRoot };
    await assert.rejects(
      runCommand({
        workspace: wrong,
        operationId: `${data}:wrong-dot`,
        command: "true",
      }),
      /ownership mismatch/,
    );
  },
);

const desktopTest = process.env.CIT_TEST_DESKTOP === "1" ? test : test.skip;
desktopTest(
  "live desktop commands share actual computer files and cancel only their job group",
  async (t) => {
    const { data } = await fixture(t);
    const workspace = await createComputerWorkspace(
      data,
      "dot-live",
      "task-desktop",
    );
    const manager = new DesktopManager({
      dataDir: data,
      image: process.env.CIT_DESKTOP_IMAGE || "cit-dots-desktop:latest",
    });
    try {
      const installed = await runCommand({
        workspace,
        operationId: `${data}:live-home-venv`,
        command: 'python3 -m venv "$HOME/portable-venv"',
      });
      assert.equal(installed.exitCode, 0, installed.stderr);
      const started = await manager.start("dot-live");
      assert.equal(started.state, "running", started.error);
      const name = await manager.containerName("dot-live");
      assert.ok(name);
      await writeFile(
        workspace,
        "nested/agent.py",
        'import os\nprint(os.environ["DISPLAY"])\nprint(os.getuid())\nopen(os.path.join(os.environ["HOME"], "live-state.txt"), "w").write("real desktop state")\n',
      );
      const created = await runDesktopCommand({
        workspace,
        containerName: name,
        operationId: `${data}:live-create`,
        command:
          'python3 nested/agent.py && "$HOME/portable-venv/bin/pip" --version',
      });
      assert.equal(created.exitCode, 0, created.stderr);
      assert.match(created.stdout, /:0/);
      assert.match(created.stdout, new RegExp(`\\n${computerUser().uid}\\n`));
      assert.equal(
        await fs.readFile(
          path.join(workspace.computerRoot!, "home", "live-state.txt"),
          "utf8",
        ),
        "real desktop state",
      );
      const timed = await runDesktopCommand({
        workspace,
        containerName: name,
        operationId: `${data}:live-timeout`,
        command: "sleep 30 & echo $!; wait",
        timeoutMs: 500,
      });
      assert.equal(timed.timedOut, true, timed.stderr);
      assert.equal(timed.exitCode, 124);
      const controller = new AbortController();
      const pending = runDesktopCommand({
        workspace,
        containerName: name,
        operationId: `${data}:live-cancel`,
        command: "sleep 30 & echo $!; wait",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 500);
      const canceled = await pending;
      assert.equal(canceled.canceled, true);
      assert.equal(canceled.exitCode, 130);
      const recovering = runDesktopCommand({
        workspace,
        containerName: name,
        operationId: `${data}:live-recovery`,
        command: "sleep 30 & echo $! > /workspace/recovery.pid; wait",
      });
      let recoveryPid = 0;
      for (let attempt = 0; attempt < 100 && !recoveryPid; attempt++) {
        try {
          recoveryPid = Number(
            await fs.readFile(
              path.join(workspace.root, "recovery.pid"),
              "utf8",
            ),
          );
        } catch {
          /* Wait for the guest process to start. */
        }
        if (!recoveryPid)
          await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.equal(recoveryPid > 0, true);
      await cancelDesktopCommand({
        workspace,
        containerName: name,
        operationId: `${data}:live-recovery`,
      });
      const recovered = await recovering;
      assert.equal(recovered.canceled, true);
      assert.equal(recovered.exitCode, 130);
      assert.equal((await manager.status("dot-live")).state, "running");
      const timedPid = Number(timed.stdout.trim()),
        canceledPid = Number(canceled.stdout.trim());
      assert.equal(Number.isInteger(timedPid) && timedPid > 0, true);
      assert.equal(Number.isInteger(canceledPid) && canceledPid > 0, true);
      const remaining = await runDesktopCommand({
        workspace,
        containerName: name,
        operationId: `${data}:live-check`,
        command: `test ! -e /proc/${timedPid} && test ! -e /proc/${canceledPid} && test ! -e /proc/${recoveryPid}`,
      });
      assert.equal(remaining.exitCode, 0, remaining.stderr);
      await assert.rejects(
        runDesktopCommand({
          workspace: { ...workspace, dotId: "dot-wrong" },
          containerName: name,
          command: "true",
        }),
        /ownership mismatch/,
      );
    } finally {
      await manager.remove("dot-live");
    }
  },
);
