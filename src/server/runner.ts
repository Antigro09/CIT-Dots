import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { safePath, withWorkspaceLock, type Workspace } from "./workspaces";

const exec = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;
const active = new Map<string, () => void>();

/** Issued only by the trusted approval broker for this exact invocation. */
export interface NetworkApproval {
  approvalId: string;
  operationId: string;
  commandHash: string;
  taskId: string;
}
export interface RunCommandOptions {
  workspace: Workspace;
  command: string;
  operationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  networkApproval?: NetworkApproval;
  image?: string;
}
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
  truncated: boolean;
  containerName?: string;
}

export function commandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}
export function containerName(operationId: string): string {
  return `cit-dots-${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Always use the local socket. Never forward saved remote Docker selectors.
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

export async function dockerHealth(): Promise<boolean> {
  try {
    await exec(
      "docker",
      [
        "--host=unix:///var/run/docker.sock",
        "info",
        "--format",
        "{{.ServerVersion}}",
      ],
      { timeout: 5000, env: dockerEnv() },
    );
    return true;
  } catch {
    return false;
  }
}

export async function cancelCommand(operationId: string): Promise<void> {
  active.get(operationId)?.();
  await exec(
    "docker",
    [
      "--host=unix:///var/run/docker.sock",
      "rm",
      "--force",
      containerName(operationId),
    ],
    { timeout: 5000, env: dockerEnv() },
  ).catch(() => undefined);
}

/** A crashed broker never replays an uncertain command. Inspect/remove the old container. */
export async function inspectCommand(
  operationId: string,
): Promise<{ state: "running" | "exited" | "missing"; exitCode?: number }> {
  try {
    const { stdout } = await exec(
      "docker",
      [
        "--host=unix:///var/run/docker.sock",
        "inspect",
        "--format",
        "{{json .State}}",
        containerName(operationId),
      ],
      { timeout: 5000, env: dockerEnv() },
    );
    const state = JSON.parse(stdout) as { Running: boolean; ExitCode: number };
    return {
      state: state.Running ? "running" : "exited",
      exitCode: state.Running ? undefined : state.ExitCode,
    };
  } catch {
    return { state: "missing" };
  }
}

export async function runCommand(
  options: RunCommandOptions,
): Promise<CommandResult> {
  const { workspace, command, signal } = options;
  if (
    !command.trim() ||
    Buffer.byteLength(command) > 32_768 ||
    command.includes("\0")
  )
    throw new Error("Command must be nonempty and at most 32 KiB.");
  const operationId =
    options.operationId ??
    `${workspace.taskId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const approval = options.networkApproval;
  if (
    approval &&
    (!approval.approvalId ||
      approval.operationId !== operationId ||
      approval.taskId !== workspace.taskId ||
      approval.commandHash !== commandHash(command))
  )
    throw new Error(
      "Network approval must match this task, operation, and exact command.",
    );
  const image =
    options.image ?? process.env.CIT_SANDBOX_IMAGE ?? "cit-dots-sandbox:latest";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image))
    throw new Error("Invalid sandbox image.");
  const timeout = Math.max(
    100,
    Math.min(options.timeoutMs ?? 120_000, 15 * 60_000),
  );
  return withWorkspaceLock(workspace.root, async () => {
    await safePath(workspace.root, "");
    if (signal?.aborted)
      return {
        exitCode: 130,
        stdout: "",
        stderr: "Canceled before command started.",
        canceled: true,
        timedOut: false,
        truncated: false,
      };
    const testHost =
      process.env.CIT_TEST_HOST_RUNNER === "1" &&
      process.env.NODE_ENV === "test";
    if (process.env.CIT_TEST_HOST_RUNNER === "1" && !testHost)
      throw new Error(
        "Host runner is restricted to NODE_ENV=test and trusted fixtures.",
      );
    const name = containerName(operationId);
    const args = testHost
      ? ["-lc", command]
      : [
          "--host=unix:///var/run/docker.sock",
          "run",
          "--rm",
          "--name",
          name,
          "--label",
          "cit-dots.managed=true",
          "--label",
          `cit-dots.operation=${operationId}`,
          "--init",
          "--network",
          approval ? "bridge" : "none",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--pids-limit",
          "256",
          "--memory",
          "2g",
          "--memory-swap",
          "2g",
          "--cpus",
          "2",
          "--ulimit",
          "nofile=1024:1024",
          "--user",
          `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          "--mount",
          `type=bind,src=${workspace.root},dst=/workspace`,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
          "--workdir",
          "/workspace",
          "--env",
          "HOME=/tmp",
          "--env",
          "CI=1",
          // Docker client proxy defaults must not inject host secrets into model commands.
          "--env",
          "HTTP_PROXY=",
          "--env",
          "HTTPS_PROXY=",
          "--env",
          "ALL_PROXY=",
          "--env",
          "NO_PROXY=",
          "--env",
          "http_proxy=",
          "--env",
          "https_proxy=",
          "--env",
          "all_proxy=",
          "--env",
          "no_proxy=",
          image,
          "bash",
          "-lc",
          command,
        ];
    if (!testHost && workspace.root.includes(","))
      throw new Error("Workspace path contains unsupported mount delimiter.");
    const child = spawn(testHost ? "bash" : "docker", args, {
      cwd: workspace.root,
      detached: testHost,
      env: testHost
        ? {
            PATH: process.env.PATH,
            HOME: "/tmp",
            CI: "1",
            LANG: "C.UTF-8",
            NODE_ENV: "test",
          }
        : dockerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      used = 0,
      canceled = false,
      timedOut = false,
      truncated = false;
    const append = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const remaining = MAX_OUTPUT - used;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      used += accepted.length;
      if (stream === "stdout") stdout += accepted.toString("utf8");
      else stderr += accepted.toString("utf8");
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on("data", (chunk) => append(chunk as Buffer, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk as Buffer, "stderr"));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (testHost && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        // Kill the container itself; terminating its CLI alone leaves commands alive.
        void exec(
          "docker",
          ["--host=unix:///var/run/docker.sock", "rm", "--force", name],
          { timeout: 5000, env: dockerEnv() },
        )
          .catch(() => undefined)
          .finally(() => child.kill("SIGKILL"));
      }
    };
    const abort = () => {
      canceled = true;
      stop();
    };
    active.set(operationId, abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, exitSignal) =>
          resolve(code ?? (exitSignal ? 137 : 1)),
        );
      });
      return {
        exitCode: canceled ? 130 : timedOut ? 124 : exitCode,
        stdout,
        stderr,
        timedOut,
        canceled,
        truncated,
        ...(testHost ? {} : { containerName: name }),
      };
    } catch (error) {
      throw new Error(
        `Cannot start sandbox command: ${(error as Error).message}. Build the sandbox image and check Docker access.`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      active.delete(operationId);
      if (!testHost && (stopping || signal?.aborted))
        await exec(
          "docker",
          ["--host=unix:///var/run/docker.sock", "rm", "--force", name],
          { timeout: 5000, env: dockerEnv() },
        ).catch(() => undefined);
    }
  });
}
