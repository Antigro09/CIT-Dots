import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot } from "./runtime-env.mjs";

const args = process.argv.slice(2);
let requestedOutput;
let check = false;
while (args.length) {
  const flag = args.shift();
  if (flag === "--check") check = true;
  else if (flag === "--output-dir" && args.length)
    requestedOutput = resolve(args.shift());
  else
    throw new Error(
      "Usage: node scripts/install-services.mjs [--check] [--output-dir PATH]",
    );
}
const outputDir =
  requestedOutput ||
  resolve(
    process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"),
    "systemd/user",
  );
function quote(value) {
  if (/[\r\n\0]/.test(value))
    throw new Error("Service paths cannot contain line breaks or NUL.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}
const replacements = {
  PROJECT_ROOT: projectRoot.replaceAll("%", "%%"),
  NODE: quote(process.execPath),
  NODE_BIN: dirname(process.execPath)
    .replaceAll("%", "%%")
    .replaceAll('"', '\\"'),
  LAUNCHER: quote(resolve(projectRoot, "scripts/service-launch.mjs")),
  NOTIFIER: quote(resolve(projectRoot, "scripts/notification-bridge.mjs")),
};
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const names = [
  "cit-dots-eve.service",
  "cit-dots-broker.service",
  "cit-dots-web.service",
  "cit-dots-notifications.service",
];
for (const name of names) {
  const template = await readFile(
    resolve(projectRoot, "ops/systemd", `${name}.in`),
    "utf8",
  );
  const rendered = template.replace(
    /@([A-Z_]+)@/g,
    (_, key) => replacements[key],
  );
  if (rendered.includes("@"))
    throw new Error(`Unexpanded service template: ${name}`);
  await writeFile(resolve(outputDir, name), rendered, { mode: 0o600 });
}
await writeFile(
  resolve(outputDir, "cit-dots.target"),
  await readFile(resolve(projectRoot, "ops/systemd/cit-dots.target")),
  { mode: 0o600 },
);
console.log(`Wrote five user service files to ${outputDir}.`);
if (check) {
  const result = spawnSync(
    "systemd-analyze",
    [
      "--user",
      "verify",
      ...names.map((name) => resolve(outputDir, name)),
      resolve(outputDir, "cit-dots.target"),
    ],
    { stdio: "inherit" },
  );
  if (result.error)
    throw new Error(`systemd-analyze is unavailable: ${result.error.message}`);
  process.exitCode = result.status ?? 1;
} else if (!requestedOutput) {
  console.log(
    "Run systemctl --user daemon-reload, then follow docs/runbook.md to enable services.",
  );
}
