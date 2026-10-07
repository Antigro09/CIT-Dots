import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createCipheriv } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DesktopManager,
  desktopContainerName,
  desktopNetworkName,
} from "../src/server/desktops";
import {
  ensureComputer,
  computerUser,
  createComputerWorkspace,
} from "../src/server/computers";
import { Broker } from "../src/server/broker";
import { commandHash, runDesktopCommand } from "../src/server/runner";
import type { ModelProfile, Task, ToolOperation } from "../src/shared/types";

const exec = promisify(execFile);
async function docker(args: string[]) {
  const environment = { ...process.env };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete environment[key];
  return (
    await exec("docker", ["--host=unix:///var/run/docker.sock", ...args], {
      env: environment,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout;
}

async function fixture(t: test.TestContext, dotIds: string[] = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cit-desktops-"));
  const dataDir = path.join(directory, "data");
  const manager = new DesktopManager({ dataDir });
  t.after(async () => {
    for (const dotId of dotIds) await manager.remove(dotId);
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, dataDir, manager };
}

test("desktop IDs and private metadata paths reject host traversal and symlink parents", async (t) => {
  const { dataDir, manager } = await fixture(t);
  await assert.rejects(manager.start("../outside"), /Invalid Dot/);
  await assert.rejects(manager.remove("bad/id"), /Invalid Dot/);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.symlink(os.tmpdir(), path.join(dataDir, "dots"));
  const result = await manager.start("dot-primary");
  assert.equal(result.state, "error");
  assert.match(result.error ?? "", /symlink/);
  assert.equal(result.url, null);
});

test("invalid desktop image is rejected before any Docker resource is created", async (t) => {
  const { dataDir } = await fixture(t);
  const manager = new DesktopManager({
    dataDir,
    image: () => "image --privileged",
  });
  const result = await manager.start("dot-primary");
  assert.equal(result.state, "error");
  assert.match(result.error ?? "", /Invalid graphical desktop image/);
});

/** Authenticate to the actual TigerVNC server through noVNC's WebSocket path. */
async function authenticateDisplay(url: string): Promise<string> {
  const address = new URL(url);
  const password = new URLSearchParams(address.hash.slice(1)).get("password")!;
  address.protocol = "ws:";
  address.pathname = "/websockify";
  address.search = "";
  address.hash = "";
  const socket = new WebSocket(address, ["binary"]);
  socket.binaryType = "arraybuffer";
  let buffer = Buffer.alloc(0);
  let reader:
    | {
        length: number;
        resolve: (value: Buffer) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const consume = () => {
    if (!reader || buffer.length < reader.length) return;
    const value = buffer.subarray(0, reader.length);
    buffer = buffer.subarray(reader.length);
    const completed = reader;
    reader = undefined;
    completed.resolve(value);
  };
  const timeout = setTimeout(() => {
    reader?.reject(new Error("The real VNC handshake timed out."));
    socket.close();
  }, 10_000);
  socket.addEventListener("message", (event) => {
    buffer = Buffer.concat([buffer, Buffer.from(event.data as ArrayBuffer)]);
    consume();
  });
  socket.addEventListener("close", () =>
    reader?.reject(
      new Error("The VNC server closed before authentication completed."),
    ),
  );
  const read = (length: number) =>
    new Promise<Buffer>((resolve, reject) => {
      reader = { length, resolve, reject };
      consume();
    });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("The local display WebSocket failed.")),
        { once: true },
      );
    });
    assert.equal((await read(12)).toString("ascii"), "RFB 003.008\n");
    socket.send(Buffer.from("RFB 003.008\n"));
    const count = (await read(1))[0]!;
    assert.ok(
      (await read(count)).includes(2),
      "VNC authentication must be required.",
    );
    socket.send(Buffer.from([2]));
    const challenge = await read(16);
    const key = Buffer.alloc(8);
    for (let index = 0; index < Math.min(password.length, 8); index++) {
      let value = password.charCodeAt(index),
        reversed = 0;
      for (let bit = 0; bit < 8; bit++) {
        reversed = reversed * 2 + (value & 1);
        value >>= 1;
      }
      key[index] = reversed;
    }
    const cipher = createCipheriv(
      "des-ede3-ecb",
      Buffer.concat([key, key, key]),
      null,
    );
    cipher.setAutoPadding(false);
    socket.send(Buffer.concat([cipher.update(challenge), cipher.final()]));
    assert.equal(
      (await read(4)).readUInt32BE(0),
      0,
      "Generated credentials must authenticate to TigerVNC.",
    );
    socket.send(Buffer.from([1]));
    const initialization = await read(24);
    assert.ok(initialization.readUInt16BE(0) >= 800);
    assert.ok(initialization.readUInt16BE(2) >= 600);
    return (await read(initialization.readUInt32BE(20))).toString("utf8");
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

const desktopTest = process.env.CIT_TEST_DESKTOP === "1" ? test : test.skip;
const dockerTest =
  process.env.CIT_TEST_DOCKER === "1" || process.env.CIT_TEST_DESKTOP === "1"
    ? test
    : test.skip;

dockerTest(
  "removing an unused desktop handles Docker's absent-network response without needing an image",
  async (t) => {
    const { manager } = await fixture(t);
    assert.deepEqual(await manager.remove("dot-unused"), {
      dotId: "dot-unused",
      state: "stopped",
      url: null,
      os: "Ubuntu 26.04",
    });
  },
);

desktopTest(
  "real Ubuntu desktop authenticates, runs graphical apps, remains offline and persists across reattach/stop/start",
  { timeout: 120_000 },
  async (t) => {
    const primary = "dot-primary",
      extra = "dot-extra";
    const { dataDir, manager } = await fixture(t, [primary, extra]);
    assert.equal((await manager.status(primary)).state, "stopped");
    const [started, repeated] = await Promise.all([
      manager.start(primary),
      manager.start(primary),
    ]);
    assert.equal(started.state, "running", started.error);
    assert.equal(repeated.state, "running", repeated.error);
    assert.equal(
      started.url,
      repeated.url,
      "Repeated start must reattach the same desktop.",
    );
    const address = new URL(started.url!);
    assert.equal(address.hostname, "127.0.0.1");
    assert.equal(address.searchParams.get("resize"), "remote");
    assert.equal(
      address.searchParams.get("password"),
      null,
      "Credentials must never be sent in HTTP request URLs.",
    );
    const page = await fetch(started.url!, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /noVNC/);
    assert.match(await authenticateDisplay(started.url!), /CIT Dots/);
    const name = await manager.containerName(primary);
    assert.equal(name, desktopContainerName(dataDir, primary));
    const originalId = (
      await docker(["inspect", "--format", "{{.Id}}", name!])
    ).trim();
    const metadataPath = path.join(
      dataDir,
      "dots",
      primary,
      "desktop",
      "metadata.json",
    );
    assert.equal((await fs.stat(metadataPath)).mode & 0o777, 0o600);
    const primaryComputer = await ensureComputer(dataDir, primary);
    assert.equal(
      await fs
        .readFile(
          path.join(primaryComputer.home, "Desktop", "Browser.desktop"),
          "utf8",
        )
        .then((value) => value.includes("epiphany")),
      true,
    );
    await docker([
      "exec",
      name!,
      "bash",
      "-c",
      "test \"$(id -u)\" -ne 0 && test ! -e /var/run/docker.sock && test ! -e /home/cit/metadata.json && test -x /usr/bin/epiphany && test -x /usr/bin/xfce4-terminal && test -x /usr/bin/thunar && grep -q 'VERSION_ID=\"26.04\"' /etc/os-release && printf 'persistent desktop file' > /workspace/persist.txt && printf 'saved browser preference' > /home/cit/preference.txt && ! touch /usr/guest-write",
    ]);
    const pids = await docker([
      "exec",
      name!,
      "bash",
      "-c",
      "ps -eo comm | sort -u",
    ]);
    assert.match(pids, /xfce4-session/);
    assert.match(pids, /xfwm4/);
    const applicationKey = "a".repeat(64);
    await docker([
      "exec",
      "--detach",
      name!,
      "python3",
      "/opt/cit/desktop-job.py",
      "run",
      applicationKey,
      "12",
      "xfce4-terminal --disable-server --title=DesktopSmoke --working-directory=/workspace & thunar /workspace & epiphany --private-instance about:blank & wait",
    ]);
    let windows = "";
    let visibleWindows = "";
    const applicationDeadline = Date.now() + 10_000;
    while (Date.now() < applicationDeadline) {
      windows = await docker(["exec", name!, "xwininfo", "-root", "-tree"]);
      visibleWindows = windows
        .split("\n")
        .filter((line) => {
          const geometry = line.match(/\s(\d+)x(\d+)[+-]/);
          return (
            geometry && Number(geometry[1]) > 200 && Number(geometry[2]) > 100
          );
        })
        .join("\n");
      if (
        /DesktopSmoke/.test(visibleWindows) &&
        /Thunar/i.test(visibleWindows) &&
        /epiphany/i.test(visibleWindows)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.match(
      visibleWindows,
      /DesktopSmoke/,
      "The real terminal must create a graphical window.",
    );
    assert.match(
      visibleWindows,
      /Thunar/i,
      "The real file manager must create a graphical window.",
    );
    assert.match(
      visibleWindows,
      /epiphany/i,
      "The real browser must create a graphical window.",
    );
    await docker([
      "exec",
      name!,
      "python3",
      "/opt/cit/desktop-job.py",
      "cancel",
      applicationKey,
    ]);
    await fs.writeFile(
      path.join(primaryComputer.workspace, "daemon.py"),
      "import os,time\nif os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\ntime.sleep(30)\n",
    );
    await docker([
      "exec",
      name!,
      "python3",
      "/opt/cit/desktop-job.py",
      "run",
      "b".repeat(64),
      "5",
      "python3 /workspace/daemon.py",
    ]);
    await docker([
      "exec",
      name!,
      "python3",
      "-c",
      "from pathlib import Path\nfor entry in Path('/proc').iterdir():\n if entry.name.isdigit():\n  try: arguments=(entry/'cmdline').read_bytes().split(b'\\0')\n  except OSError: continue\n  assert b'/workspace/daemon.py' not in arguments, 'detached job descendant survived'\n",
    ]);
    const broker = new Broker({
      config: {
        dataDir,
        internalToken: "desktop-recovery-fixture",
        tickMs: 100_000,
      },
      desktops: manager,
    });
    broker.updateSettings({ paused: true });
    try {
      const profile = broker.store.insert<ModelProfile>("models", {
        name: "Recovery fixture",
        provider: "lmstudio",
        baseUrl: "http://127.0.0.1:9/v1",
        modelId: "fixture",
        contextWindow: 4096,
        maxOutputTokens: 256,
        temperature: 0,
        status: "ready",
        capabilities: { tools: true, streaming: true },
      });
      const session = broker.createSession({
        dotId: primary,
        modelProfileId: profile.id,
      });
      const task = broker.createTask({
        dotId: primary,
        sessionId: session.id,
        modelProfileId: profile.id,
        role: "coder",
        prompt: "Desktop recovery fixture",
      });
      const workspace = await createComputerWorkspace(
        dataDir,
        primary,
        task.id,
      );
      broker.store.update<Task>("tasks", task.id, {
        workspace,
        status: "running",
      });
      const operation = broker.store.insert<ToolOperation>("tool_operations", {
        taskId: task.id,
        toolName: "run_command",
        input: { command: "sleep 30" },
        status: "running",
      });
      const running = runDesktopCommand({
        workspace,
        containerName: name!,
        operationId: operation.id,
        command: "sleep 30",
        timeoutMs: 40_000,
      });
      const recoveryDeadline = Date.now() + 5000;
      let published = false;
      while (Date.now() < recoveryDeadline) {
        published = await docker([
          "exec",
          name!,
          "test",
          "-f",
          `/tmp/cit-jobs/${commandHash(operation.id)}.json`,
        ]).then(
          () => true,
          () => false,
        );
        if (published) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        published,
        "The real desktop job must be running before broker recovery.",
      );
      await broker.start();
      const recovered = await running;
      assert.equal(recovered.exitCode, 130);
      assert.equal(recovered.canceled, true);
      assert.equal(
        broker.store.require<ToolOperation>("tool_operations", operation.id)
          .status,
        "unknown",
        "An uncertain command must not be replayed after restart.",
      );
      assert.equal(
        (await manager.status(primary)).state,
        "running",
        "Recovery cancels only the old job, preserving the desktop.",
      );
    } finally {
      await broker.stop();
      broker.store.close();
    }
    const offline = await docker([
      "exec",
      name!,
      "python3",
      "-c",
      "import socket; s=socket.socket(); s.settimeout(1); blocked=False\ntry: s.connect(('1.1.1.1',443))\nexcept OSError: blocked=True\nassert blocked, 'desktop outbound internet must be blocked'\nprint('outbound blocked')",
    ]);
    assert.match(offline, /outbound blocked/);
    const info = JSON.parse(await docker(["inspect", name!]))[0];
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);
    assert.equal(
      info.Config.User,
      `${computerUser().uid}:${computerUser().gid}`,
    );
    assert.equal(info.HostConfig.PidsLimit, 512);
    assert.equal(info.HostConfig.Memory, 4 * 1024 ** 3);
    assert.equal(info.HostConfig.NanoCpus, 2 * 10 ** 9);
    assert.equal(
      JSON.parse(
        await docker([
          "network",
          "inspect",
          desktopNetworkName(dataDir, primary),
        ]),
      )[0].Internal,
      true,
    );

    await manager.close();
    assert.equal(
      (
        await docker(["inspect", "--format", "{{.State.Running}}", name!])
      ).trim(),
      "true",
      "Closing the broker display relay must preserve the computer.",
    );
    const reattached = new DesktopManager({ dataDir });
    t.after(() => reattached.close());
    const resumed = await reattached.status(primary);
    assert.equal(resumed.state, "running", resumed.error);
    assert.equal(
      (await docker(["inspect", "--format", "{{.Id}}", name!])).trim(),
      originalId,
    );
    assert.match(await authenticateDisplay(resumed.url!), /CIT Dots/);
    const extraStatus = await manager.start(extra);
    assert.equal(extraStatus.state, "running", extraStatus.error);
    const extraName = (await manager.containerName(extra))!;
    const differentComputer = await docker([
      "exec",
      extraName,
      "bash",
      "-c",
      "test ! -e /workspace/persist.txt && test ! -e /home/cit/preference.txt && printf separate > /workspace/extra.txt",
    ]);
    assert.equal(differentComputer, "");
    assert.equal((await manager.stop(primary)).state, "stopped");
    assert.equal(await manager.containerName(primary), null);
    assert.equal(
      await fs.readFile(
        path.join(primaryComputer.workspace, "persist.txt"),
        "utf8",
      ),
      "persistent desktop file",
    );
    const restarted = await manager.start(primary);
    assert.equal(restarted.state, "running", restarted.error);
    await docker([
      "exec",
      name!,
      "bash",
      "-c",
      "grep -q 'persistent desktop file' /workspace/persist.txt && grep -q 'saved browser preference' /home/cit/preference.txt",
    ]);
    assert.equal((await manager.remove(extra)).state, "stopped");
    await assert.rejects(docker(["inspect", extraName]), /No such/);
    await assert.rejects(
      docker(["network", "inspect", desktopNetworkName(dataDir, extra)]),
      /No such|network .+ not found/i,
    );
    assert.equal(
      (await manager.status(primary)).state,
      "running",
      "Removing another Dot must preserve the primary desktop.",
    );
  },
);

desktopTest(
  "foreign named Docker containers and networks are never attached, stopped or removed",
  async (t) => {
    const { dataDir, manager } = await fixture(t);
    const dotId = "dot-collision";
    const name = desktopContainerName(dataDir, dotId);
    const network = desktopNetworkName(dataDir, dotId);
    const networkId = (
      await docker([
        "network",
        "create",
        "--internal",
        "--label",
        "cit-dots.desktop.owner=someone-else",
        network,
      ])
    ).trim();
    const containerId = (
      await docker([
        "create",
        "--name",
        name,
        "--network",
        network,
        "--label",
        "cit-dots.managed=true",
        "cit-dots-sandbox:latest",
        "sleep",
        "60",
      ])
    ).trim();
    t.after(async () => {
      await docker(["rm", "--force", containerId]);
      await docker(["network", "rm", networkId]);
    });
    for (const result of [
      await manager.status(dotId),
      await manager.start(dotId),
      await manager.stop(dotId),
      await manager.remove(dotId),
    ]) {
      assert.equal(result.state, "error");
      assert.match(result.error ?? "", /another owner/);
      assert.equal(result.url, null);
    }
    assert.equal(
      (await docker(["inspect", "--format", "{{.Id}}", name])).trim(),
      containerId,
    );
    assert.equal(
      JSON.parse(await docker(["network", "inspect", network]))[0].Id,
      networkId,
    );
  },
);
