import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  ComputerAction,
  ComputerCursor,
  ComputerResult,
} from "../shared/computer";

const exec = promisify(execFile);
const HELPER = "/opt/cit/computer-control.py";
const cancellations = new Map<string, Promise<void>>();
const cursorSchema = z
  .object({
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    cursor: z
      .object({ x: z.number().int().min(0), y: z.number().int().min(0) })
      .strict(),
  })
  .strict();
const resultSchema = cursorSchema.extend({
  action: z.enum([
    "screenshot",
    "move",
    "click",
    "scroll",
    "type",
    "key",
    "drag",
  ]),
  image: z
    .object({
      mimeType: z.literal("image/png"),
      data: z.string().max(3 * 1024 * 1024),
    })
    .strict()
    .optional(),
});

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete env[key];
  return env;
}

/** Only an already inspected, owned container ID may enter this executor. */
async function helper(
  container: string,
  arguments_: string[],
  signal?: AbortSignal,
) {
  const { stdout } = await exec(
    "docker",
    [
      "--host=unix:///var/run/docker.sock",
      "exec",
      "--env",
      "DISPLAY=:0",
      "--env",
      "XAUTHORITY=/tmp/cit-vnc/Xauthority",
      "--env",
      "XDG_RUNTIME_DIR=/tmp/cit-runtime",
      container,
      "python3",
      HELPER,
      ...arguments_,
    ],
    { env: environment(), signal, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

export function computerActionId(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex").slice(0, 32);
}

export async function cancelComputerAction(
  container: string,
  jobId: string,
): Promise<void> {
  const key = `${container}:${jobId}`;
  const existing = cancellations.get(key);
  if (existing) return existing;
  const current = helper(container, ["cancel", jobId]).then(() => undefined);
  cancellations.set(key, current);
  try {
    await current;
  } finally {
    if (cancellations.get(key) === current) cancellations.delete(key);
  }
}

export async function computerCursor(
  container: string,
): Promise<ComputerCursor> {
  return cursorSchema.parse(JSON.parse(await helper(container, ["cursor"])));
}

/** Killing a docker CLI alone does not stop its guest process. Cancel the exact
 * trusted helper job too, so timeout and human takeover release injected input. */
export async function runComputerAction(
  container: string,
  input: ComputerAction,
  jobId: string,
  signal?: AbortSignal,
): Promise<ComputerResult> {
  signal?.throwIfAborted();
  let cancellation: Promise<void> | undefined;
  const stop = () => {
    cancellation ??= cancelComputerAction(container, jobId);
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
    const raw = await helper(container, ["run", jobId, encoded], signal);
    const result = resultSchema.parse(JSON.parse(raw));
    if (result.action !== input.action)
      throw new Error("The desktop helper returned a different action.");
    if (input.action === "screenshot") {
      const png = Buffer.from(result.image?.data ?? "", "base64");
      if (
        result.image?.mimeType !== "image/png" ||
        png.byteLength > 2 * 1024 * 1024 ||
        !png
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error(
          "The desktop helper did not return a bounded PNG screenshot.",
        );
    } else if (result.image) {
      throw new Error("Only screenshot actions may return image bytes.");
    }
    return result;
  } catch (error) {
    stop();
    if (signal?.aborted)
      throw new Error(
        "Computer action canceled. No input was queued for replay.",
      );
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      stderr?.slice(0, 1000) ||
        (error as Error).message ||
        "The desktop action failed.",
    );
  } finally {
    signal?.removeEventListener("abort", stop);
    if (cancellation) await cancellation;
  }
}
