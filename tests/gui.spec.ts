/** Screenshots use a disposable, explicitly labeled test fixture, never default user data. */
import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const binaryFileName = "calculator-result.bin";
const binaryFileBytes = Buffer.concat([
  Buffer.from("Coding worker binary download fixture\n", "utf8"),
  Buffer.from([0, 1, 255, 128, 42]),
]);

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

async function expectDotConversationReady(page: Page) {
  const userMessages = page.getByRole("main").locator(".message-user");
  await expect(userMessages).toHaveCount(2);
  await expect(userMessages.nth(0)).toContainText(
    "The calculator adds numbers incorrectly.",
  );
  await expect(userMessages.nth(1)).toContainText(
    `Please send me calculator-review.md and ${binaryFileName} from your worker.`,
  );
  await expect(
    page.getByRole("main").getByText("Loading message…", { exact: true }),
  ).toHaveCount(0);
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
  const coordinator = await api<Task>("/tasks", {
    sessionId: session.id,
    title: "Fix addition and verify tests",
    prompt: "Fix the addition function and run the calculator tests.",
    role: "coordinator",
    projectId: project.id,
    modelProfileId: profile.id,
  });
  broker.store.addMessage(session.id, {
    id: randomUUID(),
    role: "user",
    content:
      "The calculator adds numbers incorrectly. Can you fix it, run the tests, and show me the changes?",
    taskId: coordinator.id,
    kind: "chat",
  });
  broker.store.update("tasks", coordinator.id, { status: "running" });
  const delegated = await broker.executeTool({
    taskId: coordinator.id,
    callId: "gui-delegate-calculator",
    toolName: "delegate",
    input: {
      role: "coder",
      prompt: "Fix the addition function and prepare the isolated diff.",
      title: "Fix addition and verify tests",
      wait: false,
    },
  });
  task = broker.store.require<Task>(
    "tasks",
    (delegated as { childTaskId: string }).childTaskId,
  );
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
  broker.store.addMessage(task.sessionId, {
    id: randomUUID(),
    role: "assistant",
    content:
      "The coding worker prepared this implementation in the isolated workspace.\n\n```js\nexport const add = (a, b) => a + b;\n```",
    taskId: task.id,
    kind: "result",
  });
  broker.store.update("tasks", coordinator.id, { status: "completed" });
  broker.store.addMessage(session.id, {
    id: randomUUID(),
    role: "assistant",
    content:
      "The addition function now uses addition. My coding worker prepared the change in its workspace. You can inspect the diff before applying it.",
    taskId: coordinator.id,
    kind: "result",
  });
  const requested = broker.addUserMessage(session.id, {
    content: `Please send me calculator-review.md and ${binaryFileName} from your worker.`,
  });
  broker.store.update("tasks", requested.task.id, { status: "running" });
  const fileDelegation = await broker.executeTool({
    taskId: requested.task.id,
    callId: "gui-delegate-files",
    toolName: "delegate",
    input: {
      role: "coder",
      prompt:
        "Prepare the requested calculator review and binary result files.",
      title: "Prepare calculator output files",
      wait: false,
    },
  });
  const fileWorker = broker.store.require<Task>(
    "tasks",
    (fileDelegation as { childTaskId: string }).childTaskId,
  );
  broker.store.update("tasks", fileWorker.id, { status: "running" });
  await broker.executeTool({
    taskId: fileWorker.id,
    callId: "gui-write-review-file",
    toolName: "write_file",
    input: {
      path: "calculator-review.md",
      content:
        "# Calculator review\n\nThe addition function now uses +. Review the isolated coding diff before applying it.\n",
    },
  });
  const fileWorkspace = broker.store.require<Task>(
    "tasks",
    fileWorker.id,
  ).workspace!;
  expect(fileWorkspace.scope).toBe("computer");
  await writeFile(join(fileWorkspace.root, binaryFileName), binaryFileBytes);
  broker.store.update("tasks", fileWorker.id, { status: "completed" });
  for (const path of ["calculator-review.md", binaryFileName]) {
    const forwarded = await broker.executeTool({
      taskId: requested.task.id,
      callId: `gui-forward-${path}`,
      toolName: "forward_file",
      input: {
        sourceTaskId: fileWorker.id,
        requestMessageId: requested.message.id,
        path,
      },
    });
    expect(forwarded.result).toMatchObject({ file: { name: path } });
  }
  broker.store.update("tasks", requested.task.id, { status: "completed" });
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
    page.locator(".message-assistant pre, .message-assistant code"),
  ).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("export const add");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("main")
      .getByRole("link", { name: /Download calculator-result\.bin/ })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe(binaryFileName);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath!)).toEqual(binaryFileBytes);
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Models" }),
  ).toBeVisible();
  await expectDotConversationReady(page);
  await page.screenshot({
    path: join(screenshotsDir, "chat.png"),
    fullPage: true,
    animations: "disabled",
  });

  await page.goto(`${webUrl}/sessions/${task.sessionId}`);
  await expect(page.getByRole("main")).toContainText(
    "The coding worker prepared this implementation",
  );
  await expect(page.getByRole("main").locator("pre")).toContainText(
    "export const add",
  );

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
  await expectDotConversationReady(page);
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
  const workTask = broker.store.list<Task>("tasks", {
    predicate: (item) => item.sessionId === workId,
  })[0];
  expect(workTask.role).toBe("coder");
  await expect(page.locator(".dot-identity-card")).toHaveCount(0);
  broker.updateSettings({ paused: false });
  broker.store.update("tasks", workTask.id, { status: "running" });
  const implementation = "export const standalone_work_marker = 7;\n";
  await broker.executeTool({
    taskId: workTask.id,
    callId: "gui-independent-write",
    toolName: "write_file",
    input: { path: "standalone-result.mjs", content: implementation },
  });
  broker.store.update("tasks", workTask.id, {
    status: "completed",
    result: "Prepared standalone-result.mjs in the independent workspace.",
  });
  broker.store.addMessage(workId, {
    role: "assistant",
    content: `Prepared the implementation in standalone-result.mjs.\n\n\`\`\`js\n${implementation}\`\`\``,
    taskId: workTask.id,
    kind: "result",
  });
  broker.updateSettings({ paused: true });
  await page.reload();
  await expect(page.getByRole("main").locator("pre")).toContainText(
    "standalone_work_marker",
  );
  await page.screenshot({
    path: join(screenshotsDir, "independent-work-result.png"),
    fullPage: true,
    animations: "disabled",
  });
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
  await expectDotConversationReady(page);
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
    await expect(
      page.getByRole("button", { name: "Desktop", exact: true }),
    ).toHaveClass(/is-active/);
    const startButton = page.getByRole("button", {
      name: "Start desktop",
      exact: true,
    });
    await expect(startButton).toBeEnabled();
    const startPath = "/api/local/dots/dot-primary/computer/start";
    const [startRequest, startResponse] = await Promise.all([
      page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname === startPath,
        { timeout: 15_000 },
      ),
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === startPath,
        { timeout: 120_000 },
      ),
      startButton.click(),
    ]);
    expect(startRequest.postDataJSON()).toEqual({});
    const startResult = await startResponse.json();
    expect(startResponse.status(), JSON.stringify(startResult)).toBe(200);
    expect(startResult.desktop.state, startResult.desktop.error).toBe(
      "running",
    );
    expect(startResult.desktop.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await expect(page.locator(".computer-controls .tag")).toHaveText(
      "running",
      { timeout: 15_000 },
    );
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
    await expect(page.getByRole("status")).toContainText(
      "Agent has control · You are watching",
    );
    const viewerIsReadOnly = () =>
      desktop.locator("html").evaluate(async () => {
        const modulePath = "./app/ui.js";
        const { default: ui } = await import(modulePath);
        return ui.rfb.viewOnly;
      });
    await expect.poll(viewerIsReadOnly).toBe(true);
    broker.updateSettings({ paused: false });
    const computerParent = broker.createTask({
      sessionId: session.id,
      role: "coordinator",
      prompt: "Have a worker verify the real graphical desktop controls.",
      title: "Verify shared desktop control",
    });
    const computerDelegation = await broker.executeTool({
      taskId: computerParent.id,
      callId: "gui-delegate-computer",
      toolName: "delegate",
      input: {
        role: "coder",
        prompt:
          "Use the graphical desktop and verify its shared input controls.",
        title: "Graphical desktop verification",
        wait: false,
      },
    });
    const computerWorker = broker.store.require<Task>(
      "tasks",
      String(computerDelegation.childTaskId),
    );
    broker.store.update<Task>("tasks", computerWorker.id, {
      status: "running",
      profileSnapshot: {
        ...computerWorker.profileSnapshot,
        capabilities: { streaming: true, tools: true, vision: true },
      },
    });
    const computerAction = (input: Record<string, unknown>) =>
      broker.executeTool({
        taskId: computerWorker.id,
        callId: randomUUID(),
        toolName: "computer",
        input,
      });
    const moved = await computerAction({
      action: "move",
      x: 123,
      y: 87,
      durationMs: 700,
    });
    expect(moved.result).toMatchObject({ cursor: { x: 123, y: 87 } });
    const agentCursor = desktop.locator("#cit-agent-cursor");
    await expect(agentCursor).toBeVisible();
    await expect(agentCursor).toHaveAttribute("data-x", "123");
    await expect(agentCursor).toHaveAttribute("data-y", "87");
    const pointerMapping = await agentCursor.evaluate((pointer) => {
      const canvas = document.querySelector("#noVNC_container canvas")!;
      const bounds = canvas.getBoundingClientRect();
      const cursorBounds = pointer.getBoundingClientRect();
      const data = (pointer as HTMLElement).dataset;
      return {
        x: cursorBounds.left,
        y: cursorBounds.top,
        expectedX:
          bounds.left + (Number(data.x) / Number(data.width)) * bounds.width,
        expectedY:
          bounds.top + (Number(data.y) / Number(data.height)) * bounds.height,
      };
    });
    expect(pointerMapping.x).toBeCloseTo(pointerMapping.expectedX, 0);
    expect(pointerMapping.y).toBeCloseTo(pointerMapping.expectedY, 0);
    const moveSamples: { x: number; y: number }[] = [];
    let movePending = true;
    const collectMove = (async () => {
      while (movePending) {
        const point = await agentCursor.evaluate((pointer) => ({
          x: Number((pointer as HTMLElement).dataset.x),
          y: Number((pointer as HTMLElement).dataset.y),
        }));
        moveSamples.push(point);
        await delay(50);
      }
    })();
    try {
      const smoothMove = await computerAction({
        action: "move",
        x: 423,
        y: 287,
        durationMs: 1500,
      });
      expect(smoothMove.result).toMatchObject({ cursor: { x: 423, y: 287 } });
    } finally {
      movePending = false;
      await collectMove;
    }
    expect(
      moveSamples.some(
        (point) =>
          point.x > 123 && point.x < 423 && point.y > 87 && point.y < 287,
      ),
      `The live viewer must show an intermediate real pointer position before the smooth move returns: ${JSON.stringify(moveSamples)}`,
    ).toBe(true);
    await expect(agentCursor).toHaveAttribute("data-x", "423");
    await expect(agentCursor).toHaveAttribute("data-y", "287");
    const finalMapping = await agentCursor.evaluate((pointer) => {
      const bounds = document
        .querySelector("#noVNC_container canvas")!
        .getBoundingClientRect();
      const cursorBounds = pointer.getBoundingClientRect();
      const data = (pointer as HTMLElement).dataset;
      return {
        x: cursorBounds.left,
        y: cursorBounds.top,
        expectedX: bounds.left + (423 / Number(data.width)) * bounds.width,
        expectedY: bounds.top + (287 / Number(data.height)) * bounds.height,
      };
    });
    expect(finalMapping.x).toBeCloseTo(finalMapping.expectedX, 0);
    expect(finalMapping.y).toBeCloseTo(finalMapping.expectedY, 0);
    await page
      .getByRole("button", { name: "Take control", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "You have control · Agent input paused",
    );
    await expect.poll(viewerIsReadOnly).toBe(false);
    await expect(agentCursor).toBeHidden();
    const blocked = await computerAction({
      action: "move",
      x: 124,
      y: 88,
    }).catch((error) => ({ result: { error: String(error) } }));
    expect(blocked.result).toMatchObject({
      error: expect.stringMatching(/human|control|input/i),
    });
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
    await page
      .getByRole("button", { name: "Give control back", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Agent has control · You are watching",
    );
    await expect.poll(viewerIsReadOnly).toBe(true);
    await computerAction({ action: "key", keys: ["Alt", "F2"] });
    const windowTree = async () =>
      (await exec("docker", ["exec", container, "xwininfo", "-root", "-tree"]))
        .stdout;
    await expect.poll(windowTree).toContain("Application Finder");
    await computerAction({
      action: "type",
      text: "xfce4-terminal --disable-server --title 'CIT agent UI verification' --geometry 90x24+120+120",
    });
    await computerAction({ action: "key", keys: ["Return"] });
    await expect.poll(windowTree).toContain("CIT agent UI verification");
    const geometry = await exec("docker", [
      "exec",
      container,
      "xdotool",
      "search",
      "--name",
      "^CIT agent UI verification$",
      "getwindowgeometry",
      "--shell",
    ]);
    const windowX = Number(geometry.stdout.match(/^X=(\d+)$/m)?.[1]);
    const windowY = Number(geometry.stdout.match(/^Y=(\d+)$/m)?.[1]);
    expect(Number.isFinite(windowX) && Number.isFinite(windowY)).toBe(true);
    await computerAction({
      action: "click",
      x: windowX + 160,
      y: windowY + 100,
    });
    await computerAction({ action: "scroll", direction: "down", amount: 2 });
    await computerAction({
      action: "type",
      text: "printf 'Agent UI input reached the real desktop\\n' > /workspace/agent-keyboard-check.txt",
    });
    await computerAction({ action: "key", keys: ["Return"] });
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `${webUrl}/api/local/dots/dot-primary/computer/file?path=agent-keyboard-check.txt`,
        );
        return response.ok() ? (await response.json()).content : "";
      })
      .toBe("Agent UI input reached the real desktop\n");
    await computerAction({
      action: "move",
      x: windowX + 330,
      y: windowY + 140,
      durationMs: 500,
    });
    await expect(agentCursor).toBeVisible();
    await expect(agentCursor).toHaveAttribute("data-x", String(windowX + 330));
    await page.screenshot({
      path: join(screenshotsDir, "computer-agent.png"),
      fullPage: true,
      animations: "disabled",
    });
    broker.store.update("tasks", computerWorker.id, { status: "completed" });
    broker.store.update("tasks", computerParent.id, { status: "completed" });
    broker.updateSettings({ paused: true });
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
    await expect(page.locator(".identity-output-files")).not.toContainText(
      "browser-keyboard-check.txt",
    );
    await expect(page.locator(".identity-output-files")).toContainText(
      binaryFileName,
    );
    await expectDotConversationReady(page);
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
