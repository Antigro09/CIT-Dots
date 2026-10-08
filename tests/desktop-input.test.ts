import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computerActionSchema } from "../src/shared/computer";
import { computerActionId } from "../src/server/computer-control";
import { DesktopManager } from "../src/server/desktops";

test("desktop input schema rejects command fields, unsafe key names, and unbounded inputs", () => {
  for (const value of [
    { action: "screenshot", command: "touch /host/file" },
    { action: "key", keys: ["Ctrl", "c;touch /host/file"] },
    { action: "key", keys: ["--window", "123"] },
    { action: "move", x: -1, y: 300 },
    { action: "move", x: 300, y: 300, durationMs: 60_000 },
    { action: "click", x: 300 },
    { action: "scroll", direction: "up", y: 300 },
    { action: "scroll", direction: "down", amount: 500 },
    { action: "type", text: "a".repeat(4001) },
    { action: "type", text: "test\0null" },
  ])
    assert.equal(computerActionSchema.safeParse(value).success, false);
  assert.deepEqual(
    computerActionSchema.parse({ action: "key", keys: ["Ctrl", "Alt", "t"] }),
    { action: "key", keys: ["Ctrl", "Alt", "t"] },
  );
  assert.deepEqual(
    computerActionSchema.parse({
      action: "type",
      text: "literal `text` $HOME\nUnicode: café",
    }),
    { action: "type", text: "literal `text` $HOME\nUnicode: café" },
  );
  assert.match(computerActionId("../../outside"), /^[a-f0-9]{32}$/);
  assert.equal(
    computerActionId("same-operation"),
    computerActionId("same-operation"),
  );
});

test("human desktop takeover persists outside guest mounts and remains scoped to one Dot", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cit-desktop-input-"),
  );
  const manager = new DesktopManager({ dataDir: directory });
  t.after(async () => {
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  assert.equal((await manager.controlStatus("dot-primary")).mode, "agent");
  assert.equal(
    (await manager.setControl("dot-primary", "human")).mode,
    "human",
  );
  const reattached = new DesktopManager({ dataDir: directory });
  t.after(() => reattached.close());
  assert.equal((await reattached.controlStatus("dot-primary")).mode, "human");
  assert.equal((await reattached.controlStatus("dot-extra")).mode, "agent");
  const stateFile = path.join(
    directory,
    "dots",
    "dot-primary",
    "desktop",
    "control.json",
  );
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  assert.equal(
    (
      await fs.readdir(
        path.join(directory, "dots", "dot-primary", "computer", "home"),
      )
    ).includes("control.json"),
    false,
  );
  const pending = JSON.parse(await fs.readFile(stateFile, "utf8"));
  await fs.writeFile(stateFile, JSON.stringify({ ...pending, pending: true }));
  assert.equal(
    (await reattached.controlStatus("dot-primary")).pending,
    true,
    "Unconfirmed takeover remains pending after reattachment.",
  );
  assert.equal(
    (await reattached.setControl("dot-primary", "agent")).mode,
    "agent",
  );
  await assert.rejects(
    manager.setControl("../outside", "human"),
    /Invalid Dot/,
  );
});

test("control state rejects foreign ownership and metadata symlinks", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cit-desktop-input-"),
  );
  const manager = new DesktopManager({ dataDir: directory });
  t.after(async () => {
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await manager.controlStatus("dot-primary");
  const stateFile = path.join(
    directory,
    "dots",
    "dot-primary",
    "desktop",
    "control.json",
  );
  const data = JSON.parse(await fs.readFile(stateFile, "utf8"));
  await fs.writeFile(stateFile, JSON.stringify({ ...data, owner: "foreign" }));
  await assert.rejects(manager.controlStatus("dot-primary"), /ownership/);
  const target = path.join(directory, "outside.json");
  await fs.writeFile(target, JSON.stringify(data));
  await fs.unlink(stateFile);
  await fs.symlink(target, stateFile);
  await assert.rejects(manager.controlStatus("dot-primary"), /ELOOP|symbolic/i);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), data);
});
