import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeModel } from "./fake-model";
import type {
  ModelProfile,
  Project,
  Session,
  Task,
  ToolOperation,
  Approval,
} from "../src/shared/types";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

test(
  "actual broker, production Eve, local provider and Docker complete coding with a reviewer",
  {
    skip: process.env.CIT_TEST_EVE !== "1",
    timeout: 120_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cit-full-stack-"));
    const fake = await createFakeModel();
    const [controlPort, evePort] = await Promise.all([freePort(), freePort()]);
    const projectPath = join(directory, "project");
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "calculator.mjs"),
      "export const add = (a, b) => a - b;\n",
    );
    await writeFile(
      join(projectPath, "calculator.test.mjs"),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calculator.mjs';\ntest('addition', () => assert.equal(add(2, 3), 5));\n",
    );
    await exec("git", ["init", "--quiet", projectPath]);
    await exec("git", ["-C", projectPath, "add", "."]);
    await exec("git", [
      "-C",
      projectPath,
      "-c",
      "user.name=CIT test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture baseline",
    ]);
    const workflowDirectory = join(directory, ".eve", ".workflow-data");
    const env = {
      CIT_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
      CIT_EVE_URL: `http://127.0.0.1:${evePort}`,
      CIT_INTERNAL_TOKEN: "isolated-full-stack-test-token",
      CIT_DATA_DIR: join(directory, "application"),
      WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${evePort}`,
      WORKFLOW_LOCAL_DATA_DIR: workflowDirectory,
      CIT_TEST_HOST_RUNNER: "",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    let worker: ChildProcess | undefined;
    let output = "";
    let closeApp: (() => Promise<void>) | undefined;
    try {
      // These imports occur after isolated process configuration is installed.
      const { createApp } = await import("../src/server/api");
      const { workerHealth } = await import("../src/server/eve-worker");
      const app = createApp();
      const broker = app.broker;
      closeApp = async () => {
        await app.close();
        broker.store.close();
      };
      await app.listen({ host: "127.0.0.1", port: controlPort });
      // Eve 0.72 computes Workflow storage from cwd and ignores the data-dir
      // override. The private cwd is the isolation boundary for its run files.
      worker = spawn(process.execPath, [resolve(".output/server/index.mjs")], {
        cwd: directory,
        env: {
          ...process.env,
          ...env,
          HOST: "127.0.0.1",
          PORT: String(evePort),
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const capture = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-20_000);
      };
      worker.stdout?.on("data", capture);
      worker.stderr?.on("data", capture);
      worker.on("error", (error) => {
        output += String(error);
      });
      await eventually(workerHealth, (value) => value, "Eve readiness");
      const request = async <T>(
        path: string,
        body?: unknown,
        method?: string,
      ): Promise<T> => {
        const response = await fetch(
          `${env.CIT_CONTROL_URL}/api/local${path}`,
          {
            method: method ?? (body === undefined ? "GET" : "POST"),
            headers:
              body === undefined ? {} : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        );
        const data = await response.json();
        assert(response.ok, `${path}: ${JSON.stringify(data)}`);
        return data as T;
      };
      const model = await request<ModelProfile>("/models", {
        name: "Isolated full-stack fixture",
        provider: "lmstudio",
        baseUrl: fake.baseUrl,
        modelId: "fixture-chat",
        contextWindow: 32768,
        maxOutputTokens: 512,
        temperature: 0,
      });
      const probed = await request<ModelProfile>(
        `/models/${model.id}/probe`,
        {},
      );
      assert.equal(probed.capabilities?.tools, true);
      const project = await request<Project>("/projects", {
        path: projectPath,
      });
      await request(
        "/settings",
        {
          maxActiveTasks: 4,
          maxConcurrentInference: 2,
          maxTokensPerGoal: 500_000,
        },
        "PATCH",
      );
      await broker.start();
      const getTask = async (id: string) =>
        (await request<{ task: Task }>(`/tasks/${id}`)).task;
      const waitTask = (id: string) =>
        eventually(
          () => getTask(id),
          (task) =>
            ["completed", "failed", "canceled", "interrupted"].includes(
              task.status,
            ),
          "task completion",
        );
      const chatSession = await request<Session>("/sessions", {
        modelProfileId: model.id,
      });
      const chat = await request<{ task: Task }>(
        `/sessions/${chatSession.id}/messages`,
        { content: "fixture:chat Hello locally." },
      );
      const chatDone = await waitTask(chat.task.id);
      assert.equal(chatDone.status, "completed", chatDone.error);
      assert.match(chatDone.result ?? "", /Local fixture reply/);

      const task = await request<Task>("/tasks", {
        prompt:
          "fixture:coding Fix the calculator, run its test, and delegate a review.",
        role: "coder",
        projectId: project.id,
        modelProfileId: model.id,
      });
      const finished = await waitTask(task.id);
      assert.equal(finished.status, "completed", finished.error);
      const detail = await request<{
        task: Task;
        children: Task[];
        operations: ToolOperation[];
      }>(`/tasks/${task.id}`);
      assert.equal(detail.children.length, 1);
      assert.equal(detail.children[0].role, "reviewer");
      assert.equal(
        detail.children[0].status,
        "completed",
        detail.children[0].error,
      );
      const command = detail.operations.find(
        (operation) => operation.toolName === "run_command",
      );
      assert(command && command.status === "completed");
      const result = command.result as {
        exitCode: number;
        stdout: string;
        containerName?: string;
      };
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.match(result.stdout, /pass 1/);
      assert(
        result.containerName?.startsWith("cit-dots-"),
        "Coding must use the real Docker runner.",
      );
      const diff = await request<{ patch: string }>(`/tasks/${task.id}/diff`);
      assert.match(diff.patch, /a \+ b/);
      assert.match(
        await readFile(join(projectPath, "calculator.mjs"), "utf8"),
        /a - b/,
      );
      await request(`/tasks/${task.id}/apply`, {});
      assert.match(
        await readFile(join(projectPath, "calculator.mjs"), "utf8"),
        /a \+ b/,
      );

      // Approval travels through the same real broker, Eve workflow and runner.
      const approvalTask = await request<Task>("/tasks", {
        prompt: "fixture:approval Request the command's network permission.",
        projectId: project.id,
        modelProfileId: model.id,
      });
      await eventually(
        () => getTask(approvalTask.id),
        (value) => value.status === "waiting_approval",
        "visible approval",
      );
      const snapshot = await request<{ approvals: Approval[] }>("/snapshot");
      const approval = snapshot.approvals.find(
        (item) => item.taskId === approvalTask.id && item.status === "pending",
      );
      assert(approval);
      await request(`/approvals/${approval.id}/decide`, {
        decision: "approve",
      });
      const approved = await waitTask(approvalTask.id);
      assert.equal(approved.status, "completed", approved.error);
      assert.match(approved.result ?? "", /approved command completed/);
      const recordedRuns = await readdir(join(workflowDirectory, "runs"));
      for (const completedTask of [
        chatDone,
        finished,
        detail.children[0],
        approved,
      ]) {
        assert(completedTask.eveSessionId);
        assert(
          recordedRuns.includes(`${completedTask.eveSessionId}.json`),
          `Eve session ${completedTask.eveSessionId} must persist under the isolated temporary cwd.`,
        );
      }
      assert(
        fake.requests.some((item) =>
          item.messages.some((message) => message.role === "tool"),
        ),
        "Provider must see real tool results.",
      );
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\nProduction Eve output:\n${output}`,
        { cause: error },
      );
    } finally {
      await closeApp?.();
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const exited = new Promise<void>((done) =>
          worker!.once("exit", () => done()),
        );
        try {
          process.kill(-worker.pid!, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
        await Promise.race([exited, delay(3000)]);
      }
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fake.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
