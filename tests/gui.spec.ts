/** Screenshots use a disposable, explicitly labeled test fixture, never default user data. */
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Broker } from "../src/server/broker";
import { createApp } from "../src/server/api";
import { createFakeModel } from "./fake-model";
import type { Task, ModelProfile, Project, Session } from "../src/shared/types";

const exec = promisify(execFile);
const screenshotsDir = resolve("artifacts/screenshots");
let dir: string;
let web: ChildProcess;
let webUrl: string;
let broker: Broker;
let app: Awaited<ReturnType<typeof createApp>>;
let fake: Awaited<ReturnType<typeof createFakeModel>>;
let session: Session;
let task: Task;

test.use({
  viewport: { width: 1600, height: 1050 },
  launchOptions: {
    executablePath:
      process.env.CIT_CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: ["--no-sandbox"],
  },
});
test.setTimeout(180_000);

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to reserve fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cit-gui-fixture-"));
  const projectPath = join(dir, "calculator-project");
  await mkdir(projectPath);
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(
    join(projectPath, "calculator.mjs"),
    "export const add = (a, b) => a - b;\n",
  );
  await writeFile(
    join(projectPath, "calculator.test.mjs"),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calculator.mjs';\ntest('adds both operands', () => assert.equal(add(2, 3), 5));\n",
  );
  await exec("git", ["init", "--quiet", projectPath]);
  await exec("git", ["-C", projectPath, "add", "."]);
  await exec("git", [
    "-C",
    projectPath,
    "-c",
    "user.name=CIT screenshot fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Screenshot baseline",
  ]);
  fake = await createFakeModel();
  broker = new Broker({
    config: { dataDir: join(dir, "data"), internalToken: "gui-fixture-token" },
  });
  app = await createApp({ broker, config: broker.config });
  const brokerUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const api = async <T>(
    path: string,
    body: unknown,
    method = "POST",
  ): Promise<T> => {
    const response = await fetch(`${brokerUrl}/api/local${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
    return data as T;
  };
  const profile = await api<ModelProfile>("/models", {
    name: "Local model · screenshot fixture",
    provider: "lmstudio",
    baseUrl: fake.baseUrl,
    modelId: "fixture-coder",
    contextWindow: 32_768,
    maxOutputTokens: 2048,
    temperature: 0.2,
    capabilities: { streaming: true, tools: true },
  });
  await api(`/models/${profile.id}/probe`, {});
  await api(
    "/settings",
    { defaultModelProfileId: profile.id, paused: false, theme: "dark" },
    "PATCH",
  );
  const project = await api<Project>("/projects", {
    name: "Calculator project",
    path: projectPath,
  });
  session = await api<Session>("/sessions", {
    title: "Improve the calculator",
    modelProfileId: profile.id,
    projectId: project.id,
  });
  task = await api<Task>("/tasks", {
    sessionId: session.id,
    title: "Fix addition and verify tests",
    prompt: "Fix the addition function and run the calculator tests.",
    role: "coder",
    projectId: project.id,
    modelProfileId: profile.id,
  });
  broker.store.addMessage(session.id, {
    id: randomUUID(),
    role: "user",
    content:
      "The calculator adds numbers incorrectly. Can you fix it, run the tests, and show me the changes?",
    taskId: task.id,
    kind: "chat",
  });
  broker.store.update("tasks", task.id, { status: "running" });
  // Actual file tools produce the patch and operation records shown in the UI.
  await broker.executeTool({
    taskId: task.id,
    callId: "gui-read",
    toolName: "read_file",
    input: { path: "calculator.mjs" },
  });
  await broker.executeTool({
    taskId: task.id,
    callId: "gui-write",
    toolName: "write_file",
    input: {
      path: "calculator.mjs",
      content: "export const add = (a, b) => a + b;\n",
    },
  });
  await broker.executeTool({
    taskId: task.id,
    callId: "gui-progress",
    toolName: "report_progress",
    input: {
      message:
        "I found the problem: addition was subtracting the second value. The fix is ready in a separate workspace.",
    },
  });
  broker.store.update("tasks", task.id, {
    status: "completed",
    result: "The addition function now uses +. The change is ready for review.",
    tokenUsage: 1232,
    toolCount: 3,
  });
  broker.store.addMessage(session.id, {
    id: randomUUID(),
    role: "assistant",
    content:
      "The addition function now uses `+` instead of `−`.\n\n```js\nexport const add = (a, b) => a + b;\n```\n\nThe change is prepared in an isolated workspace. Open the coding workspace to inspect the diff before applying it.",
    taskId: task.id,
    kind: "result",
  });
  await api("/settings", { paused: true }, "PATCH");
  await api("/goals", {
    title: "Morning project check",
    objective:
      "Inspect the calculator project and report meaningful changes or questions.",
    projectId: project.id,
    modelProfileId: profile.id,
    scheduleType: "cron",
    cron: "0 9 * * 1-5",
    timezone: "America/New_York",
    nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    enabled: true,
    overlap: "skip",
  });
  await api("/memories", {
    title: "Project preferences",
    content:
      "Keep changes small, run the existing tests, and prepare diffs for review.",
    source: "Screenshot fixture instruction",
  });
  const port = await freePort();
  webUrl = `http://127.0.0.1:${port}`;
  let log = "";
  web = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CIT_CONTROL_URL: brokerUrl,
        CIT_DATA_DIR: join(dir, "data"),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  web.stdout?.on("data", (chunk) => {
    log = (log + chunk.toString()).slice(-8000);
  });
  web.stderr?.on("data", (chunk) => {
    log = (log + chunk.toString()).slice(-8000);
  });
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    if (web.exitCode !== null) throw new Error(`GUI server exited: ${log}`);
    try {
      if ((await fetch(`${webUrl}/api/local/snapshot`)).ok) return;
    } catch {
      /* Starting. */
    }
    await delay(250);
  }
  throw new Error(`GUI fixture did not start: ${log}`);
});

test.afterAll(async () => {
  if (web?.pid) {
    web.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (web.exitCode !== null) resolve();
      else {
        web.once("exit", () => resolve());
        setTimeout(resolve, 3000);
      }
    });
  }
  if (broker) {
    await broker.stop();
    broker.store.close();
  }
  if (app) await app.close();
  if (fake) await fake.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("actual GUI renders chat, coding changes, goals, mobile layout, and visible errors", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(webUrl);
  await expect(
    page.getByRole("heading", { name: /What shall we/ }),
  ).toBeVisible();
  await expect(page.locator(".dots-console")).toHaveCSS("display", "flex");
  await page.screenshot({
    path: join(screenshotsDir, "welcome.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(`${webUrl}/sessions/${session.id}`);
  await expect(page.getByRole("main")).toContainText(
    "The addition function now uses",
  );
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Models" }),
  ).toBeVisible();
  await page.screenshot({
    path: join(screenshotsDir, "chat.png"),
    fullPage: true,
    animations: "disabled",
  });

  await page.goto(`${webUrl}/tasks/${task.id}`);
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("calculator.mjs");
  await expect(page.locator(".diff-output")).toContainText("a + b");
  const patchLayout = await page
    .locator(".diff-output")
    .evaluate((element) => ({
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
    }));
  expect(patchLayout.contentWidth).toBeLessThan(patchLayout.width * 2);
  await page.screenshot({
    path: join(screenshotsDir, "coding.png"),
    fullPage: true,
    animations: "disabled",
  });

  await page.goto(`${webUrl}/goals`);
  await expect(page.getByRole("main")).toContainText("Morning project check");
  await page.screenshot({
    path: join(screenshotsDir, "goals.png"),
    fullPage: true,
    animations: "disabled",
  });

  await page.goto(`${webUrl}/memory`);
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Browser-written preference");
  await page
    .getByLabel("Memory", { exact: true })
    .fill("Show a reviewable patch before applying changes.");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Browser-written preference",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Browser-written preference",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Delete Browser-written preference",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Browser-written preference",
      exact: true,
    }),
  ).toHaveCount(0);

  await page.goto(`${webUrl}/models`);
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await page
    .getByLabel("Profile name", { exact: true })
    .fill("Rejected external fixture");
  await page
    .getByLabel("OpenAI-compatible endpoint", { exact: true })
    .fill("http://example.com/v1");
  await page.getByLabel("Model ID", { exact: true }).fill("unavailable-model");
  await page
    .getByRole("button", { name: "Connect model", exact: true })
    .click();
  await expect(page.locator(".error-banner[role=alert]")).toContainText(
    "loopback",
  );
  await page
    .getByRole("button", { name: "Dismiss error", exact: true })
    .click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${webUrl}/sessions/${session.id}`);
  await expect(page.getByRole("main")).toContainText(
    "The addition function now uses",
  );
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: join(screenshotsDir, "mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await expect(page.locator(".dots-console")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await page
    .locator(".dots-sidebar")
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  await page.screenshot({
    path: join(screenshotsDir, "mobile-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.goto(webUrl);
  await expect(page.locator(".dots-console")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await page.screenshot({
    path: join(screenshotsDir, "welcome-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(consoleErrors).toEqual([]);
});
