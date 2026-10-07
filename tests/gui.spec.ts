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
import { desktopContainerName } from "../src/server/desktops";
import { createFakeModel } from "./fake-model";
import type {
  Dot,
  Task,
  ModelProfile,
  Project,
  Session,
} from "../src/shared/types";

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
  actionTimeout: 15_000,
  navigationTimeout: 30_000,
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
  const canonicalResponse = await fetch(
    `${brokerUrl}/api/local/dots/dot-primary/session`,
  );
  expect(canonicalResponse.ok).toBe(true);
  session = (await canonicalResponse.json()) as Session;
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
  await api(
    "/dots/dot-primary/computer/file",
    {
      path: "calculator-review.md",
      content:
        "# Calculator review\n\nThe addition function now uses +. Review the isolated coding diff before applying it.\n",
    },
    "PUT",
  );
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
    if (process.env.CIT_TEST_DESKTOP === "1") {
      const desktop = await broker.desktops.remove("dot-primary");
      expect(desktop.state, desktop.error).toBe("stopped");
    }
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
    page.getByRole("heading", { name: "What's on your mind?", exact: true }),
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

  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("General coding context");
  await page
    .getByLabel("Memory", { exact: true })
    .fill("Run the existing checks.");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "General coding context", exact: true }),
  ).toBeVisible();
  expect(
    broker.store.list<{ id: string; title: string; dotId?: string | null }>(
      "memories",
      {
        predicate: (item) => item.title === "General coding context",
      },
    )[0].dotId,
  ).toBeNull();
  await page
    .getByRole("button", { name: "Edit General coding context", exact: true })
    .click();
  await page
    .getByLabel("Memory", { exact: true })
    .fill("Run checks and show the changed files.");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("main")).toContainText(
    "Run checks and show the changed files.",
  );
  await page.getByRole("button", { name: "Pip's memory", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "General coding context", exact: true }),
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

test("Chat and Work create independent sessions without a Dot identity", async ({
  page,
}) => {
  await page.request.patch(`${webUrl}/api/local/settings`, {
    data: { theme: "dark" },
  });
  await page.goto(`${webUrl}/chat`);
  await expect(
    page.getByRole("link", { name: "New chat", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("group", { name: "New session mode" }),
  ).toBeVisible();
  await expect(page.locator(".dot-identity-card")).toHaveCount(0);
  const welcomeBounds = await page.locator(".welcome").boundingBox();
  const composerBounds = await page.locator(".chat-composer").boundingBox();
  expect(
    composerBounds!.y - (welcomeBounds!.y + welcomeBounds!.height),
  ).toBeLessThan(45);
  await page.screenshot({
    path: join(screenshotsDir, "independent-chat.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByLabel("Message CIT Dots", { exact: true })
    .fill("An independent conversation, without a pet context.");
  let releaseMessage!: () => void;
  let messageReceived!: () => void;
  const messageResponseGate = new Promise<void>((resolve) => {
    releaseMessage = resolve;
  });
  const receivedMessage = new Promise<void>((resolve) => {
    messageReceived = resolve;
  });
  await page.route("**/api/local/sessions/*/messages", async (route) => {
    const response = await route.fetch();
    messageReceived();
    await messageResponseGate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await receivedMessage;
  try {
    await expect(
      page.getByLabel("Message CIT Dots", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Attach text files", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseMessage();
  }
  await page.waitForURL(/\/sessions\//);
  await page.unroute("**/api/local/sessions/*/messages");
  const chatId = page.url().split("/").at(-1)!;
  expect(broker.store.require<Session>("sessions", chatId).dotId).toBeNull();
  expect(broker.store.require<Session>("sessions", chatId).kind).toBe("chat");
  await expect(page.locator(".dot-identity-card")).toHaveCount(0);
  await page.getByRole("link", { name: "New chat", exact: true }).click();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "What should we work on?", exact: true }),
  ).toBeVisible();
  const project = broker.store.list<Project>("projects")[0];
  await page.getByLabel("Project", { exact: true }).selectOption(project.id);
  await page.screenshot({
    path: join(screenshotsDir, "independent-work.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByLabel("Message CIT Dots", { exact: true })
    .fill("Inspect the calculator in an independent work session.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForURL(/\/sessions\//);
  const workId = page.url().split("/").at(-1)!;
  const work = broker.store.require<Session>("sessions", workId);
  expect(work.dotId).toBeNull();
  expect(work.kind).toBe("work");
  expect(
    broker.store.list<Task>("tasks", {
      predicate: (item) => item.sessionId === workId,
    })[0].role,
  ).toBe("coder");
  await expect(page.locator(".dot-identity-card")).toHaveCount(0);
});

test("Dots can be personalized and selected while their real computer files remain separate", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(`${webUrl}/dots`);
  await expect(
    page.getByRole("button", { name: "Remove Pip", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("main")
    .getByRole("button", { name: "Personalize Pip", exact: true })
    .click();
  await page.getByLabel("Dot name", { exact: true }).fill("Pip Scholar");
  await page
    .getByLabel("Personality", { exact: true })
    .fill("Curious, patient, and careful about showing the evidence.");
  await page.getByRole("button", { name: "Save Dot", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Meet Pip Scholar.", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Meet Pip Scholar.", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove Pip Scholar", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Add a Dot", exact: true }).click();
  await page.getByLabel("Dot name", { exact: true }).fill("Nova");
  await page
    .getByLabel("Personality", { exact: true })
    .fill("A friendly investigator who checks the details.");
  await page.locator('input[name="avatar-kind"][value="cat"]').check();
  await page.getByRole("button", { name: "Create Dot", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Meet Nova.", exact: true }),
  ).toBeVisible();
  const nova = broker.store.list<Dot>("dots", {
    predicate: (item) => item.name === "Nova",
  })[0];
  expect(nova.avatar.kind).toBe("cat");
  await page.screenshot({
    path: join(screenshotsDir, "pet-home.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(`${webUrl}/dots/${nova.id}/computer?tab=files`);
  await page
    .getByRole("button", { name: "Create a file", exact: true })
    .click();
  await page.getByLabel("New file path", { exact: true }).fill("welcome.md");
  await page
    .getByLabel("File contents", { exact: true })
    .fill("Nova keeps this note on its own computer.\n");
  let releaseFile!: () => void;
  let fileReceived!: () => void;
  const fileResponseGate = new Promise<void>((resolve) => {
    releaseFile = resolve;
  });
  const receivedFile = new Promise<void>((resolve) => {
    fileReceived = resolve;
  });
  const fileRoute = `**/api/local/dots/${nova.id}/computer/file`;
  await page.route(fileRoute, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    fileReceived();
    await fileResponseGate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await receivedFile;
  try {
    await expect(
      page.getByLabel("File contents", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Create workspace file", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("New file path", { exact: true }),
    ).toBeDisabled();
  } finally {
    releaseFile();
  }
  await expect(page.getByRole("status")).toContainText("Saved to computer");
  await page.unroute(fileRoute);
  await page.reload();
  await page.getByRole("button", { name: /welcome\.md/ }).click();
  await expect(page.getByLabel("File contents", { exact: true })).toHaveValue(
    "Nova keeps this note on its own computer.\n",
  );
  await page.screenshot({
    path: join(screenshotsDir, "computer-files.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page
    .locator(".sidebar-dots")
    .getByRole("button", { name: "Open Pip Scholar", exact: true })
    .click();
  await page.waitForURL(/\/dots\/dot-primary$/);
  await expect(page.locator(".dot-identity-card")).toContainText("Pip Scholar");
  const firstCanonical = broker.store.require<Dot>(
    "dots",
    "dot-primary",
  ).sessionId;
  expect(firstCanonical).toBe(session.id);
  await expect(page.getByRole("main")).toContainText(
    "The addition function now uses",
  );
  await expect(page.locator(".identity-output-files")).toContainText(
    "calculator-review.md",
  );
  await expect(page.locator(".identity-computer")).toContainText(
    "Desktop stopped",
  );
  await page.reload();
  await expect(page.locator(".dot-identity-card")).toContainText("Pip Scholar");
  expect(broker.store.require<Dot>("dots", "dot-primary").sessionId).toBe(
    firstCanonical,
  );
  await expect(page.getByRole("main")).toContainText(
    "The addition function now uses",
  );
  await expect(page.locator(".identity-output-files")).toContainText(
    "calculator-review.md",
  );
  await expect(page.locator(".identity-computer")).toContainText(
    "Desktop stopped",
  );
  await page.screenshot({
    path: join(screenshotsDir, "pet-chat.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(`${webUrl}/dots/dot-primary/computer?tab=files`);
  await expect(page.getByRole("button", { name: /welcome\.md/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Desktop", exact: true }).click();
  if (process.env.CIT_TEST_DESKTOP === "1") {
    await page
      .getByRole("button", { name: "Start desktop", exact: true })
      .click();
    await expect(
      page.getByTitle("Pip Scholar's Ubuntu desktop", { exact: true }),
    ).toBeVisible({ timeout: 120_000 });
    const desktop = page.frameLocator(
      'iframe[title="Pip Scholar\'s Ubuntu desktop"]',
    );
    await expect(desktop.locator("html")).toHaveClass(/noVNC_connected/, {
      timeout: 120_000,
    });
    await expect(desktop.locator("#noVNC_container canvas")).toBeVisible();
    const canvasSize = await desktop
      .locator("#noVNC_container canvas")
      .evaluate((canvas) => ({
        width: (canvas as HTMLCanvasElement).width,
        height: (canvas as HTMLCanvasElement).height,
      }));
    expect(canvasSize.width).toBeGreaterThan(600);
    expect(canvasSize.height).toBeGreaterThan(400);
    const container = desktopContainerName(
      broker.config.dataDir,
      "dot-primary",
    );
    const sessionBus = await exec("docker", [
      "exec",
      container,
      "cat",
      "/tmp/cit-runtime/dbus-address",
    ]);
    const nssLibrary = await exec("docker", [
      "exec",
      container,
      "find",
      "/usr/lib",
      "-name",
      "libnss_wrapper.so",
      "-print",
      "-quit",
    ]);
    await exec("docker", [
      "exec",
      "-d",
      "--env",
      `DBUS_SESSION_BUS_ADDRESS=${sessionBus.stdout.trim()}`,
      "--env",
      "NSS_WRAPPER_PASSWD=/tmp/cit-passwd",
      "--env",
      "NSS_WRAPPER_GROUP=/tmp/cit-group",
      "--env",
      `LD_PRELOAD=${nssLibrary.stdout.trim()}`,
      container,
      "xfce4-terminal",
      "--disable-server",
      "--title",
      "CIT desktop input verification",
      "--geometry",
      "100x28+100+100",
    ]);
    await expect
      .poll(async () => {
        const result = await exec("docker", [
          "exec",
          container,
          "xwininfo",
          "-root",
          "-tree",
        ]);
        return result.stdout;
      })
      .toContain("CIT desktop input verification");
    await desktop.locator("#noVNC_container canvas").click();
    await page.keyboard.type(
      "printf 'Keyboard input reached the real Ubuntu desktop\\n' > /workspace/browser-keyboard-check.txt",
      { delay: 15 },
    );
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `${webUrl}/api/local/dots/dot-primary/computer/file?path=browser-keyboard-check.txt`,
        );
        return response.ok() ? (await response.json()).content : "";
      })
      .toBe("Keyboard input reached the real Ubuntu desktop\n");
  }
  await page.screenshot({
    path: join(screenshotsDir, "computer.png"),
    fullPage: true,
    animations: "disabled",
  });
  if (process.env.CIT_TEST_DESKTOP === "1") {
    await page.goto(`${webUrl}/dots/dot-primary`);
    await expect(page.getByRole("main")).toContainText(
      "The addition function now uses",
    );
    await expect(page.locator(".identity-computer")).toContainText("Connected");
    await expect(page.locator(".identity-output-files")).toContainText(
      "browser-keyboard-check.txt",
    );
    await page.screenshot({
      path: join(screenshotsDir, "pet-chat.png"),
      fullPage: true,
      animations: "disabled",
    });
  }
  const routedProfileResponse = await page.request.post(
    `${webUrl}/api/local/models`,
    {
      data: {
        name: "Coordinator routing verification",
        provider: "lmstudio",
        baseUrl: fake.baseUrl,
        modelId: "fixture-coder",
        contextWindow: 16_384,
        maxOutputTokens: 1024,
        temperature: 0.2,
      },
    },
  );
  expect(routedProfileResponse.ok()).toBe(true);
  const routedProfile = (await routedProfileResponse.json()) as ModelProfile;
  const originalProfile = task.modelProfileId;
  await page.request.patch(`${webUrl}/api/local/settings`, {
    data: { roleModelProfileIds: { coordinator: routedProfile.id } },
  });
  await page.goto(`${webUrl}/dots/dot-primary`);
  await expect(
    page.getByLabel("Model for the next response", { exact: true }),
  ).toHaveValue(routedProfile.id);
  await page
    .getByLabel("Message CIT Dots", { exact: true })
    .fill("Use the displayed coordinator model for this next task.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(
      () =>
        broker.store.list<Task>("tasks", {
          predicate: (item) =>
            item.prompt ===
            "Use the displayed coordinator model for this next task.",
        })[0]?.modelProfileId,
    )
    .toBe(routedProfile.id);
  await expect(
    page.getByLabel("Message CIT Dots", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Message CIT Dots", { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Model for the next response", { exact: true })
    .selectOption(originalProfile);
  await page
    .getByLabel("Message CIT Dots", { exact: true })
    .fill("Use the explicit model override for this task.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(
      () =>
        broker.store.list<Task>("tasks", {
          predicate: (item) =>
            item.prompt === "Use the explicit model override for this task.",
        })[0]?.modelProfileId,
    )
    .toBe(originalProfile);
  await page.goto(`${webUrl}/dots`);
  await page.getByRole("button", { name: "Remove Nova", exact: true }).click();
  await page.getByRole("button", { name: "Remove Dot", exact: true }).click();
  await expect(
    page
      .locator(".sidebar-dots")
      .getByRole("button", { name: "Open Nova", exact: true }),
  ).toHaveCount(0);
  expect(broker.store.get("dots", nova.id)).toBeUndefined();
  expect(broker.store.require<Dot>("dots", "dot-primary").isPrimary).toBe(true);
  expect(consoleErrors).toEqual([]);
});
