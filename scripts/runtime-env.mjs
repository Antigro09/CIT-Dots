import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function loadRuntimeEnv() {
  try {
    loadEnvFile(resolve(projectRoot, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function dataDir() {
  return resolve(projectRoot, process.env.CIT_DATA_DIR || ".cit-data");
}

export function controlUrl() {
  const url = new URL(process.env.CIT_CONTROL_URL || "http://127.0.0.1:4318");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(
      "The desktop bridge and diagnostics require a loopback control URL.",
    );
  }
  if (url.username || url.password)
    throw new Error("Use a URL without embedded credentials.");
  return url;
}

export async function internalToken() {
  const token =
    process.env.CIT_INTERNAL_TOKEN ||
    (await readFile(resolve(dataDir(), "internal-token"), "utf8")).trim();
  if (!token)
    throw new Error("No internal token is available; start the broker first.");
  return token;
}
