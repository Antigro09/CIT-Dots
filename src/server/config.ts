import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  process.loadEnvFile(resolve(".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export interface AppConfig {
  dataDir: string;
  controlUrl: string;
  eveUrl: string;
  host: string;
  port: number;
  tickMs: number;
  internalToken?: string;
}
export function getConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: resolve(process.env.CIT_DATA_DIR || ".cit-data"),
    controlUrl: process.env.CIT_CONTROL_URL || "http://127.0.0.1:4318",
    eveUrl: process.env.CIT_EVE_URL || "http://127.0.0.1:4319",
    host: "127.0.0.1",
    port: Number(process.env.CIT_PORT || 4318),
    tickMs: 1000,
    ...overrides,
  };
}
export const config = getConfig();
export function internalToken(settings: AppConfig = config): string {
  if (settings.internalToken) return settings.internalToken;
  if (process.env.CIT_INTERNAL_TOKEN) return process.env.CIT_INTERNAL_TOKEN;
  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  const file = resolve(settings.dataDir, "internal-token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const token = randomBytes(32).toString("hex");
    try {
      writeFileSync(file, token, { mode: 0o600, flag: "wx" });
      return token;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code === "EEXIST")
        return readFileSync(file, "utf8").trim();
      throw writeError;
    }
  }
}
