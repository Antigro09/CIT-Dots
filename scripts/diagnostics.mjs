import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { ownedDesktopFilters } from "./desktop-ownership.mjs";
import {
  controlUrl,
  dataDir,
  internalToken,
  loadRuntimeEnv,
  projectRoot,
} from "./runtime-env.mjs";

loadRuntimeEnv();
console.log(`Node: ${process.version}`);
console.log(`Project: ${projectRoot}`);
console.log(`Application data: ${dataDir()}`);
for (const [label, command, args] of [
  ["Docker engine", "docker", ["version", "--format", "{{.Server.Version}}"]],
  [
    "GPU name, VRAM MiB, driver",
    "nvidia-smi",
    ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
  ],
]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 8_000 });
  console.log(
    `${label}: ${result.status === 0 ? result.stdout.trim() : "unavailable or inaccessible"}`,
  );
}
for (const path of [
  resolve(dataDir(), "cit.sqlite"),
  resolve(dataDir(), "dots"),
  resolve(projectRoot, ".eve/.workflow-data"),
]) {
  await access(path).then(
    () => console.log(`State path exists: ${path}`),
    () => console.log(`State path not created yet: ${path}`),
  );
}
const desktopResult = spawnSync(
  "docker",
  [
    "ps",
    "--all",
    ...ownedDesktopFilters(dataDir()),
    "--format",
    '{{.Label "cit-dots.dot"}}: {{.Status}}',
  ],
  { encoding: "utf8", timeout: 8_000 },
);
console.log(
  `Owned graphical computers: ${
    desktopResult.status === 0
      ? desktopResult.stdout.trim() || "none"
      : "Docker unavailable or inaccessible"
  }`,
);
try {
  const response = await fetch(new URL("/api/local/snapshot", controlUrl()), {
    headers: { Authorization: `Bearer ${await internalToken()}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const snapshot = await response.json();
  console.log(`Application health: ${JSON.stringify(snapshot.health)}`);
} catch (error) {
  console.log(
    `Application health unavailable: ${error.code === "ENOENT" ? "start the broker first" : error.message}`,
  );
}
for (const service of [
  "cit-dots-eve",
  "cit-dots-broker",
  "cit-dots-web",
  "cit-dots-notifications",
]) {
  const result = spawnSync(
    "systemctl",
    ["--user", "is-active", `${service}.service`],
    { encoding: "utf8", timeout: 5_000 },
  );
  console.log(
    `${service}: ${result.stdout?.trim() || "user systemd unavailable"}`,
  );
}
console.log(
  "Diagnostics omit tokens, environment dumps, chat messages and task contents.",
);
