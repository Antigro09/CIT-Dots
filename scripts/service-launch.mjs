import { spawn } from "node:child_process";
import { loadRuntimeEnv, projectRoot } from "./runtime-env.mjs";

loadRuntimeEnv();
const service = process.argv[2];
if (!["broker", "eve", "web"].includes(service)) {
  throw new Error("Usage: node scripts/service-launch.mjs broker|eve|web");
}
const child = spawn("npm", ["run", `start:${service}`], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`Could not launch ${service}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
