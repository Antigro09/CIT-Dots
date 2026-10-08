import Fastify, { type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Cron } from "croner";
import { Broker, defaultSettings } from "./broker";
import { getConfig, internalToken, type AppConfig } from "./config";
import { prepareModelImages } from "./model-images";
import { listFiles, readFile, writeFile } from "./workspaces";
import {
  discoverModels,
  probeModel,
  validateBaseUrl,
  InferenceGate,
} from "./models";
import type {
  Approval,
  Dot,
  Goal,
  InboxItem,
  Memory,
  ModelProfile,
  Session,
  Settings,
  Task,
  ToolOperation,
} from "../shared/types";

const idSchema = z.string().min(1).max(200);
const content = z.string().trim().min(1).max(100000);
const modelInput = z.object({
  name: z.string().min(1).max(100),
  provider: z.enum(["ollama", "lmstudio"]),
  baseUrl: z.string().url(),
  modelId: z.string().min(1).max(200),
  contextWindow: z.number().int().min(2048).max(1000000).default(16384),
  maxOutputTokens: z.number().int().min(64).max(65536).default(2048),
  temperature: z.number().min(0).max(2).default(0.4),
  visionEnabled: z.boolean().default(false),
});
const settingsInput = z
  .object({
    paused: z.boolean(),
    defaultModelProfileId: z.string().nullable(),
    roleModelProfileIds: z
      .object({
        coordinator: z.string().nullable().optional(),
        coder: z.string().nullable().optional(),
        investigator: z.string().nullable().optional(),
        reviewer: z.string().nullable().optional(),
      })
      .optional(),
    maxActiveTasks: z.number().int().min(1).max(16),
    maxConcurrentInference: z.number().int().min(1).max(16),
    maxDepth: z.number().int().min(0).max(6),
    maxSteps: z.number().int().min(1).max(128),
    maxToolCalls: z.number().int().min(1).max(500),
    maxRunMinutes: z.number().int().min(1).max(240),
    maxTokensPerGoal: z.number().int().min(1000).max(10000000),
    sandboxImage: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/),
    desktopImage: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/),
    selectedDotId: z.string().min(1).max(100),
    theme: z.enum(["dark", "light", "system"]),
  })
  .partial();
const goalInput = z.object({
  dotId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  objective: content,
  sessionId: z.string().optional(),
  projectId: z.string().nullable().default(null),
  modelProfileId: z.string().min(1),
  scheduleType: z.enum(["once", "interval", "cron"]),
  intervalMinutes: z.number().int().min(1).max(525600).optional(),
  cron: z.string().max(100).optional(),
  timezone: z.string().default("America/New_York"),
  nextRunAt: z.string().datetime({ offset: true }).optional(),
  enabled: z.boolean().default(true),
  overlap: z.enum(["skip", "queue"]).default("skip"),
});
function pathId(request: FastifyRequest) {
  return idSchema.parse((request.params as { id: string }).id);
}
function bearerValid(header: string | undefined, token: string) {
  const actual = Buffer.from(header?.replace(/^Bearer /, "") || "");
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApp(
  options: { broker?: Broker; config?: Partial<AppConfig> } = {},
) {
  const cfg = options.broker?.config || getConfig(options.config);
  const broker = options.broker || new Broker({ config: cfg });
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    forceCloseConnections: true,
  });
  app.decorate("broker", broker);
  const gate = new InferenceGate(
    () => broker.settings().maxConcurrentInference,
  );
  app.setErrorHandler((error, _request, reply) => {
    const typed = error as Error & { statusCode?: number };
    const message =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        : typed.message;
    reply.status(typed.statusCode || 400).send({ error: message });
  });
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host?.split(":")[0];
    if (host && !["localhost", "127.0.0.1", "[", "::1"].includes(host)) {
      reply.code(403).send({ error: "Local workstation access only." });
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      let valid = false;
      try {
        const u = new URL(origin);
        valid = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
      } catch {}
      if (!valid) {
        reply.code(403).send({ error: "Cross-origin access denied." });
        return;
      }
    }
    if (
      request.url.startsWith("/api/internal/") &&
      !bearerValid(request.headers.authorization, internalToken(cfg))
    ) {
      reply.code(401).send({ error: "Worker authorization required." });
      return;
    }
    if (
      ["POST", "PATCH", "PUT"].includes(request.method) &&
      !request.headers["content-type"]?.startsWith("application/json")
    ) {
      reply.code(415).send({ error: "JSON requests are required." });
      return;
    }
  });
  app.get("/api/local/health", () => ({ ok: true }));
  app.get("/api/local/snapshot", () => broker.snapshot());
  const dotInput = z
    .object({
      name: z.string().trim().min(1).max(80),
      personality: z.string().max(8000).optional(),
      avatar: z
        .object({
          kind: z.enum(["blob", "cat", "dog", "robot"]),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        })
        .strict()
        .optional(),
      modelProfileId: z.string().nullable().optional(),
    })
    .strict();
  app.post("/api/local/dots", (request) =>
    broker.createDot(dotInput.parse(request.body)),
  );
  app.patch("/api/local/dots/:id", (request) =>
    broker.updateDot(pathId(request), dotInput.partial().parse(request.body)),
  );
  app.delete("/api/local/dots/:id", (request) =>
    broker.removeDot(pathId(request)),
  );
  app.get("/api/local/dots/:id/session", (request) =>
    broker.dotSession(pathId(request)),
  );
  app.get("/api/local/files/:id", (request, reply) => {
    const { file, bytes } = broker.sharedFile(pathId(request));
    return reply
      .header("content-type", "application/octet-stream")
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
      )
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store")
      .send(bytes);
  });
  app.get("/api/local/dots/:id/computer", (request) =>
    broker.computerStatus(pathId(request)),
  );
  app.get("/api/local/dots/:id/computer/control", (request) =>
    broker.computerControlStatus(pathId(request)),
  );
  app.post("/api/local/dots/:id/computer/control", (request) =>
    broker.setComputerControl(
      pathId(request),
      z
        .object({ mode: z.enum(["agent", "human"]) })
        .strict()
        .parse(request.body).mode,
    ),
  );
  app.post("/api/local/dots/:id/computer/start", async (request) => {
    const id = pathId(request);
    return broker.withComputer(id, async () => {
      const desktop = await broker.desktops.start(id);
      broker.event("desktop.updated", { dotId: id, state: desktop.state });
      return { dotId: id, desktop };
    });
  });
  app.post("/api/local/dots/:id/computer/stop", async (request) => {
    const id = pathId(request);
    return broker.withComputer(id, async () => {
      const desktop = await broker.desktops.stop(id);
      broker.event("desktop.updated", { dotId: id, state: desktop.state });
      return { dotId: id, desktop };
    });
  });
  app.get("/api/local/dots/:id/computer/files", async (request) => {
    const path = z
      .string()
      .max(4096)
      .default(".")
      .parse((request.query as { path?: string }).path);
    return broker.withComputer(pathId(request), async () => ({
      files: await listFiles(
        await broker.computerWorkspace(pathId(request)),
        path,
      ),
    }));
  });
  app.get("/api/local/dots/:id/computer/file", async (request) => {
    const path = z
      .string()
      .min(1)
      .max(4096)
      .parse((request.query as { path?: string }).path);
    return broker.withComputer(pathId(request), async () => ({
      path,
      content: await readFile(
        await broker.computerWorkspace(pathId(request)),
        path,
      ),
    }));
  });
  app.put("/api/local/dots/:id/computer/file", async (request) => {
    const input = z
      .object({
        path: z.string().min(1).max(4096),
        content: z.string().max(500000),
      })
      .strict()
      .parse(request.body);
    return broker.withComputer(pathId(request), async () => {
      await writeFile(
        await broker.computerWorkspace(pathId(request)),
        input.path,
        input.content,
      );
      broker.event("computer.file.updated", {
        dotId: pathId(request),
        path: input.path,
      });
      return { ok: true, path: input.path };
    });
  });
  app.get("/api/local/events", async (request, reply) => {
    const parsed = Number(
      (request.query as { after?: string }).after ||
        request.headers["last-event-id"] ||
        0,
    );
    let cursor = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const flush = () => {
      for (const event of broker.store.events(cursor)) {
        reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.id;
      }
    };
    flush();
    const timer = setInterval(flush, 400);
    const heartbeat = setInterval(
      () => reply.raw.write(": keepalive\n\n"),
      15000,
    );
    reply.raw.on("close", () => {
      clearInterval(timer);
      clearInterval(heartbeat);
    });
  });
  app.post("/api/local/sessions", (request) =>
    broker.createSession(
      z
        .object({
          kind: z.enum(["dot", "chat", "work"]).optional(),
          dotId: z.string().nullable().optional(),
          title: z.string().max(200).optional(),
          projectId: z.string().nullable().optional(),
          modelProfileId: z.string().nullable().optional(),
        })
        .parse(request.body),
    ),
  );
  app.get("/api/local/sessions/:id", (request) => {
    const id = pathId(request);
    return {
      session: broker.store.require<Session>("sessions", id),
      messages: broker.store.messages(id),
      tasks: broker.store
        .list<Task>("tasks", {
          predicate: (t) => t.sessionId === id,
        })
        .map((task) => broker.publicTask(task)),
    };
  });
  app.post("/api/local/sessions/:id/messages", async (request) => {
    const output = await broker.addWorkerSessionMessage(
      pathId(request),
      z
        .object({
          content,
          modelProfileId: z.string().optional(),
          attachments: z
            .array(
              z.object({
                name: z.string().max(200),
                content: z.string().max(100000),
              }),
            )
            .max(5)
            .optional(),
        })
        .parse(request.body),
    );
    return { ...output, task: broker.publicTask(output.task) };
  });
  app.post("/api/local/tasks", (request) =>
    broker.createTask(
      z
        .object({
          dotId: z.string().nullable().optional(),
          sessionId: z.string().optional(),
          prompt: content,
          role: z
            .enum(["coordinator", "coder", "investigator", "reviewer"])
            .optional(),
          projectId: z.string().nullable().optional(),
          modelProfileId: z.string().nullable().optional(),
          title: z.string().max(200).optional(),
        })
        .parse(request.body),
    ),
  );
  app.get("/api/local/tasks/:id", (request) => {
    const id = pathId(request);
    return {
      task: broker.publicTask(broker.store.require<Task>("tasks", id)),
      children: broker.store
        .list<Task>("tasks", {
          predicate: (t) => t.parentId === id,
        })
        .map((task) => broker.publicTask(task)),
      operations: broker.store
        .list<ToolOperation>("tool_operations", {
          predicate: (op) => op.taskId === id,
        })
        .map((operation) => broker.publicOperation(operation)),
    };
  });
  app.post("/api/local/tasks/:id/cancel", async (request) =>
    broker.publicTask(await broker.cancelTask(pathId(request))),
  );
  app.post("/api/local/tasks/:id/retry", (request) => {
    return broker.publicTask(broker.retryTask(pathId(request)));
  });
  app.get("/api/local/tasks/:id/diff", (request) =>
    broker.taskDiff(pathId(request)),
  );
  app.post("/api/local/tasks/:id/apply", (request) =>
    broker.applyTask(pathId(request)),
  );
  app.post("/api/local/projects", (request) =>
    broker.addProject(
      z
        .object({
          path: z.string().min(1).max(4096),
          name: z.string().max(200).optional(),
        })
        .parse(request.body),
    ),
  );
  app.delete("/api/local/projects/:id", (request) => {
    const id = pathId(request);
    if (
      broker.store.list<Task>("tasks", {
        predicate: (t) =>
          t.projectId === id &&
          !["completed", "canceled", "failed", "interrupted"].includes(
            t.status,
          ),
      }).length
    )
      throw new Error("Finish active project tasks before unregistering.");
    broker.store.remove("projects", id);
    broker.event("project.removed", { id });
    return { ok: true };
  });
  app.post("/api/local/models", (request) => {
    const input = modelInput.parse(request.body);
    input.baseUrl = validateBaseUrl(input.baseUrl);
    if (input.maxOutputTokens >= input.contextWindow)
      throw new Error("Output limit must be smaller than context window.");
    const model = broker.store.insert<ModelProfile>("models", {
      ...input,
      status: "unknown",
    });
    if (!broker.settings().defaultModelProfileId)
      broker.updateSettings({ defaultModelProfileId: model.id });
    broker.event("model.created", model);
    return model;
  });
  app.patch("/api/local/models/:id", (request) => {
    const id = pathId(request);
    const input = modelInput.partial().parse(request.body);
    if (input.baseUrl) input.baseUrl = validateBaseUrl(input.baseUrl);
    const current = broker.store.require<ModelProfile>("models", id);
    if (
      (input.maxOutputTokens ?? current.maxOutputTokens) >=
      (input.contextWindow ?? current.contextWindow)
    )
      throw new Error("Output limit must be smaller than context window.");
    const model = broker.store.update<ModelProfile>("models", id, {
      ...input,
      status: "unknown",
      capabilities: undefined,
      error: undefined,
    });
    broker.event("model.updated", model);
    return model;
  });
  app.delete("/api/local/models/:id", (request) => {
    const id = pathId(request);
    if (
      broker.store.list<Task>("tasks", {
        predicate: (t) =>
          t.modelProfileId === id &&
          !["completed", "canceled", "failed", "interrupted"].includes(
            t.status,
          ),
      }).length
    )
      throw new Error("This model is used by an active task.");
    broker.store.remove("models", id);
    for (const dot of broker.store.list<Dot>("dots", {
      predicate: (dot) => dot.modelProfileId === id,
    }))
      broker.updateDot(dot.id, { modelProfileId: null });
    for (const session of broker.store.list<Session>("sessions", {
      predicate: (session) => session.modelProfileId === id,
    }))
      broker.store.update<Session>("sessions", session.id, {
        modelProfileId: null,
      });
    const roleModels = { ...broker.settings().roleModelProfileIds };
    for (const [role, modelId] of Object.entries(roleModels))
      if (modelId === id) roleModels[role as Task["role"]] = null;
    broker.updateSettings({ roleModelProfileIds: roleModels });
    if (broker.settings().defaultModelProfileId === id)
      broker.updateSettings({ defaultModelProfileId: null });
    broker.event("model.removed", { id });
    return { ok: true };
  });
  app.post("/api/local/models/:id/probe", async (request) => {
    const id = pathId(request);
    const model = broker.store.update<ModelProfile>(
      "models",
      id,
      await probeModel(broker.store.require<ModelProfile>("models", id)),
    );
    broker.event("model.probed", model);
    return model;
  });
  app.post("/api/local/model-discovery", async (request) => {
    const input = z
      .object({ baseUrl: z.string(), provider: z.enum(["ollama", "lmstudio"]) })
      .parse(request.body);
    return { models: await discoverModels(input.baseUrl) };
  });
  const validateGoal = (goal: ReturnType<typeof goalInput.parse>) => {
    new Intl.DateTimeFormat("en", { timeZone: goal.timezone });
    if (goal.scheduleType === "interval" && !goal.intervalMinutes)
      throw new Error("Set an interval in minutes.");
    if (goal.scheduleType === "cron") {
      if (!goal.cron || goal.cron.trim().split(/\s+/).length !== 5)
        throw new Error("Use a five-field cron expression.");
      new Cron(goal.cron, { timezone: goal.timezone });
    }
    broker.store.require<ModelProfile>("models", goal.modelProfileId);
    if (goal.projectId) broker.store.require("projects", goal.projectId);
  };
  app.post("/api/local/goals", (request) => {
    const input = goalInput.parse(request.body);
    validateGoal(input);
    const session = input.sessionId
      ? broker.store.require<Session>("sessions", input.sessionId)
      : broker.createSession({
          kind: input.dotId === null ? "work" : "dot",
          dotId: input.dotId,
          title: input.title,
          projectId: input.projectId,
          modelProfileId: input.modelProfileId,
        });
    if (input.dotId !== undefined && input.dotId !== broker.dotId(session))
      throw new Error("The goal session belongs to a different Dot.");
    if (broker.dotId(session) !== null) broker.dot(broker.dotId(session)!);
    let nextRunAt = input.nextRunAt;
    if (!nextRunAt) {
      if (input.scheduleType === "cron")
        nextRunAt = new Cron(input.cron!, { timezone: input.timezone })
          .nextRun()!
          .toISOString();
      else
        nextRunAt = new Date(
          Date.now() +
            (input.scheduleType === "interval"
              ? input.intervalMinutes! * 60000
              : 0),
        ).toISOString();
    }
    const goal = broker.store.insert<Goal>("goals", {
      ...input,
      dotId: broker.dotId(session),
      sessionId: session.id,
      nextRunAt,
    });
    broker.event("goal.created", goal);
    return goal;
  });
  app.patch("/api/local/goals/:id", (request) => {
    const id = pathId(request);
    const current = broker.store.require<Goal>("goals", id);
    const input = goalInput.parse({
      ...current,
      ...goalInput.partial().parse(request.body),
    });
    validateGoal(input);
    if (input.dotId !== undefined && input.dotId !== broker.dotId(current))
      throw new Error("A goal cannot be transferred to another Dot.");
    const session = broker.store.require<Session>(
      "sessions",
      input.sessionId || current.sessionId,
    );
    if (broker.dotId(session) !== broker.dotId(current))
      throw new Error("The goal session belongs to a different Dot.");
    const goal = broker.store.update<Goal>("goals", id, input);
    broker.event("goal.updated", goal);
    return goal;
  });
  app.delete("/api/local/goals/:id", (request) => {
    const id = pathId(request);
    broker.store.remove("goals", id);
    broker.event("goal.removed", { id });
    return { ok: true };
  });
  app.post("/api/local/goals/:id/run", (request) => {
    const goal = broker.store.require<Goal>("goals", pathId(request));
    const task = broker.createTask({
      sessionId: goal.sessionId,
      prompt: goal.objective,
      title: goal.title,
      projectId: goal.projectId,
      modelProfileId: goal.modelProfileId,
      goalId: goal.id,
    });
    broker.store.update<Goal>("goals", goal.id, {
      lastTaskId: task.id,
      lastRunAt: new Date().toISOString(),
    });
    return task;
  });
  const memorySchema = z.object({
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(20000),
    source: z.string().max(500).optional(),
  });
  app.post("/api/local/memories", (request) => {
    const input = memorySchema
      .extend({ dotId: z.string().nullable().optional() })
      .strict()
      .parse(request.body);
    const dotId = input.dotId === null ? null : broker.dot(input.dotId).id;
    const memory = broker.store.insert<Memory>("memories", { ...input, dotId });
    broker.event("memory.created", memory);
    return memory;
  });
  app.patch("/api/local/memories/:id", (request) => {
    const memory = broker.store.update<Memory>(
      "memories",
      pathId(request),
      memorySchema.partial().strict().parse(request.body),
    );
    broker.event("memory.updated", memory);
    return memory;
  });
  app.delete("/api/local/memories/:id", (request) => {
    const id = pathId(request);
    broker.store.remove("memories", id);
    broker.event("memory.removed", { id });
    return { ok: true };
  });
  app.patch("/api/local/settings", (request) => {
    const input = settingsInput.parse(request.body);
    if (input.defaultModelProfileId)
      broker.store.require<ModelProfile>("models", input.defaultModelProfileId);
    for (const id of Object.values(input.roleModelProfileIds || {}))
      if (id) broker.store.require<ModelProfile>("models", id);
    return broker.updateSettings(input);
  });
  app.post("/api/local/approvals/:id/decide", (request) => {
    const input = z
      .object({
        decision: z.enum(["approve", "deny"]),
        answer: z.string().max(20000).optional(),
      })
      .parse(request.body);
    return broker.decideApproval(pathId(request), input.decision, input.answer);
  });
  app.get("/api/local/inbox", (request) =>
    broker.store.list<InboxItem>("inbox", {
      predicate: (item) =>
        (request.query as { undelivered?: string }).undelivered === "1"
          ? !item.delivered
          : true,
    }),
  );
  app.post("/api/local/inbox/:id/read", (request) => {
    const item = broker.store.update<InboxItem>("inbox", pathId(request), {
      read: true,
    });
    broker.event("inbox.updated", item);
    return item;
  });
  app.post("/api/local/inbox/:id/delivered", (request) =>
    broker.store.update<InboxItem>("inbox", pathId(request), {
      delivered: true,
    }),
  );
  app.get("/api/internal/worker-context", (request) =>
    broker.workerContext(
      idSchema.parse((request.query as { taskId: string }).taskId),
    ),
  );
  app.post("/api/internal/tool", (request) =>
    broker.executeTool(
      z
        .object({
          taskId: idSchema,
          callId: idSchema,
          sessionId: z.string().optional(),
          toolName: z.string().max(100),
          input: z.record(z.string(), z.unknown()),
        })
        .parse(request.body),
    ),
  );
  app.get("/api/internal/tool-result", (request) => {
    const query = z
      .object({ taskId: idSchema, callId: idSchema })
      .parse(request.query);
    return broker.toolResult(query.taskId, query.callId);
  });
  app.get("/api/internal/children/:id", (request) =>
    broker.childResult(pathId(request)),
  );
  app.post(
    "/api/internal/model/:id/v1/chat/completions",
    { bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      const task = broker.store.require<Task>("tasks", pathId(request));
      if (
        ["canceled", "failed", "completed", "interrupted"].includes(task.status)
      )
        throw new Error("Task is no longer active.");
      const body = z
        .object({
          messages: z.array(z.unknown()),
          stream: z.boolean().optional(),
        })
        .passthrough()
        .parse(request.body);
      const prepared = prepareModelImages(body.messages);
      if (
        prepared.imageCount &&
        task.profileSnapshot.capabilities?.vision !== true
      )
        throw new Error("This local model has not passed its vision test.");
      body.messages = prepared.messages;
      const controller = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
      const watch = setInterval(() => {
        if (broker.store.get<Task>("tasks", task.id)?.status === "canceled")
          controller.abort();
      }, 250);
      let release: (() => void) | undefined;
      try {
        while (broker.settings().paused) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (controller.signal.aborted) throw new Error("Inference canceled.");
        }
        release = await gate.acquire(controller.signal);
        while (broker.settings().paused) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (controller.signal.aborted) throw new Error("Inference canceled.");
        }
        const settings = broker.settings();
        const root = broker.store.require<Task>("tasks", task.rootId);
        const estimate =
          prepared.estimatedTokens + task.profileSnapshot.maxOutputTokens;
        const reconcileUsage = (usage: unknown) => {
          if (!usage || typeof usage !== "object") return;
          const reported = usage as {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
          const total = Number(
            reported.total_tokens ??
              Number(reported.prompt_tokens || 0) +
                Number(reported.completion_tokens || 0),
          );
          // Keep conservative reservations; only add any excess reported by the provider.
          if (Number.isFinite(total) && total > estimate) {
            const current = broker.store.require<Task>("tasks", task.rootId);
            broker.store.update<Task>("tasks", current.id, {
              tokenUsage: (current.tokenUsage || 0) + total - estimate,
            });
          }
        };
        if (estimate > task.profileSnapshot.contextWindow)
          throw new Error(
            "Context window exceeded; start a new conversation or increase the verified model context.",
          );
        if ((root.tokenUsage || 0) + estimate > settings.maxTokensPerGoal)
          throw new Error("Goal token budget reached.");
        if ((root.steps || 0) >= settings.maxSteps)
          throw new Error("Goal model-step budget reached.");
        broker.store.update<Task>("tasks", root.id, {
          tokenUsage: (root.tokenUsage || 0) + estimate,
          steps: (root.steps || 0) + 1,
        });
        const upstream: Record<string, unknown> = {
          ...body,
          model: task.profileSnapshot.modelId,
          max_tokens: task.profileSnapshot.maxOutputTokens,
          temperature: task.profileSnapshot.temperature,
          ...(body.stream ? { stream_options: { include_usage: true } } : {}),
        };
        if (task.profileSnapshot.capabilities?.tools === false) {
          delete upstream.tools;
          delete upstream.tool_choice;
          delete upstream.parallel_tool_calls;
        }
        const response = await fetch(
          `${validateBaseUrl(task.profileSnapshot.baseUrl)}/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(upstream),
            redirect: "error",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(settings.maxRunMinutes * 60000),
            ]),
          },
        );
        if (!response.ok) {
          reply.code(502);
          return {
            error: `Local model returned ${response.status}: ${(await response.text()).slice(0, 1500)}`,
          };
        }
        if (body.stream) {
          reply.hijack();
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          let buffer = "",
            usage: unknown;
          const decoder = new TextDecoder();
          try {
            if (response.body) {
              for await (const chunk of response.body) {
                if (controller.signal.aborted) break;
                reply.raw.write(chunk);
                buffer += decoder.decode(chunk, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                if (buffer.length > 131072) buffer = "";
                for (const line of lines) {
                  if (line.startsWith("data: ") && !line.includes("[DONE]"))
                    try {
                      const data = JSON.parse(line.slice(6));
                      if (data.usage) usage = data.usage;
                    } catch {}
                }
              }
            }
            reconcileUsage(usage);
          } finally {
            reply.raw.end();
          }
          return;
        }
        const result = (await response.json()) as { usage?: unknown };
        reconcileUsage(result.usage);
        return result;
      } finally {
        clearInterval(watch);
        release?.();
      }
    },
  );
  app.addHook("onClose", async () => {
    await broker.stop();
  });
  return app as typeof app & { broker: Broker };
}
