/**
 * A deliberately deterministic OpenAI-compatible provider for integration tests.
 * It is never imported by production code and never writes application records.
 * Tool results must arrive in the transcript before the next fixture step runs.
 */
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}
export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: {
    type: string;
    function: { name: string; parameters?: Record<string, unknown> };
  }[];
  [key: string]: unknown;
}
export interface FakeReply {
  text?: string;
  tool?: { name: string; input: Record<string, unknown> };
  delayMs?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
}
export interface FakeModelOptions {
  models?: string[];
  /** Optional scripted responder; useful to fault-inject an integration scenario. */
  respond?: (
    request: CompletionRequest,
    requestNumber: number,
  ) => FakeReply | Promise<FakeReply>;
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content))
    return message.content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part)
          return String(part.text);
        return "";
      })
      .join("\n");
  return JSON.stringify(message.content ?? "");
}

function scenario(request: CompletionRequest): string {
  const userText = request.messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");
  const matches = [...userText.matchAll(/fixture:([a-z-]+)/g)];
  return matches.at(-1)?.[1] ?? "chat";
}

function completedTools(request: CompletionRequest): string[] {
  const calls = new Map<string, string>();
  const completed: string[] = [];
  for (const message of request.messages) {
    for (const call of message.tool_calls ?? [])
      calls.set(call.id, call.function.name);
    if (message.role === "tool" && message.tool_call_id) {
      const name = calls.get(message.tool_call_id);
      if (name) completed.push(name);
    }
  }
  return completed;
}

function toolName(request: CompletionRequest, desired: string): string {
  const names = request.tools?.map((tool) => tool.function.name) ?? [];
  return (
    names.find((name) => name === desired) ??
    names.find((name) => name.endsWith(desired)) ??
    desired
  );
}

/** Fixtures depend on actual tool messages, not a server-side request counter. */
export function fixtureReply(request: CompletionRequest): FakeReply {
  if (request.tools?.some((tool) => tool.function.name === "cit_probe")) {
    return { tool: { name: "cit_probe", input: { value: "ok" } } };
  }
  const currentScenario = scenario(request);
  const completed = completedTools(request);
  const done = (name: string) =>
    completed.some((actual) => actual === name || actual.endsWith(name));
  const tool = (name: string, input: Record<string, unknown>): FakeReply => ({
    tool: { name: toolName(request, name), input },
  });

  if (currentScenario === "coding") {
    if (!done("read_file"))
      return tool("read_file", { path: "calculator.mjs" });
    if (!done("write_file"))
      return tool("write_file", {
        path: "calculator.mjs",
        content: "export const add = (a, b) => a + b;\n",
      });
    if (!done("run_command"))
      return tool("run_command", {
        command: "node --test calculator.test.mjs",
      });
    if (!done("delegate"))
      return tool("delegate", {
        role: "reviewer",
        title: "Review calculator fix",
        prompt:
          "fixture:review Review the calculator diff and check the passing test output.",
      });
    return {
      text: "Fixed addition in calculator.mjs. The project test passed and the reviewer checked the change.",
    };
  }
  if (currentScenario === "review") {
    if (!done("read_file"))
      return tool("read_file", { path: "calculator.mjs" });
    return {
      text: "The reviewed calculator implementation adds both inputs correctly.",
    };
  }
  if (currentScenario === "question") {
    if (!done("ask_user"))
      return tool("ask_user", {
        question: "Which branch should I use for this change?",
      });
    return { text: "I have recorded your branch answer and can continue." };
  }
  if (currentScenario === "approval") {
    if (!done("run_command"))
      return tool("run_command", {
        command: "node -e \"console.log('approved command completed')\"",
        network: true,
      });
    return { text: "The explicitly approved command completed." };
  }
  if (currentScenario === "escape") {
    if (!done("read_file"))
      return tool("read_file", { path: "../outside-secret.txt" });
    return { text: "The tool rejected access outside the approved workspace." };
  }
  if (currentScenario === "nested") {
    if (!done("delegate"))
      return tool("delegate", {
        role: "investigator",
        title: "Nested child",
        prompt:
          "fixture:nested Continue nested delegation to verify the enforced depth limit.",
      });
    return { text: "Nested delegation finished within the configured limit." };
  }
  if (currentScenario === "slow")
    return { text: "Slow fixture finished.", delayMs: 15_000 };
  if (currentScenario === "budget")
    return {
      text: "This response deliberately reports more tokens than the configured task budget.",
      usage: { prompt_tokens: 30_000, completion_tokens: 30_000 },
    };
  if (currentScenario === "progress") {
    if (!done("report_progress"))
      return tool("report_progress", {
        message: "The scheduled project inspection is complete.",
      });
    return {
      text: "The background check completed without another user message.",
    };
  }
  return { text: `Local fixture reply from ${request.model}.` };
}

function completion(request: CompletionRequest, reply: FakeReply) {
  const id = `chatcmpl-${randomUUID()}`;
  const call = reply.tool
    ? {
        id: `call_${randomUUID()}`,
        type: "function",
        function: {
          name: reply.tool.name,
          arguments: JSON.stringify(reply.tool.input),
        },
      }
    : undefined;
  const usage = reply.usage ?? { prompt_tokens: 19, completion_tokens: 13 };
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply.text ?? null,
          ...(call ? { tool_calls: [call] } : {}),
        },
        finish_reason: call ? "tool_calls" : "stop",
      },
    ],
    usage: {
      ...usage,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
    },
  };
}

async function waitForReply(
  response: ServerResponse,
  milliseconds: number,
): Promise<boolean> {
  if (response.destroyed) return false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once("close", abort);
  try {
    await delay(milliseconds, undefined, { signal: controller.signal });
    return !response.destroyed;
  } catch (error) {
    if ((error as Error).name === "AbortError") return false;
    throw error;
  } finally {
    response.off("close", abort);
  }
}

async function streamCompletion(
  response: ServerResponse,
  request: CompletionRequest,
  reply: FakeReply,
): Promise<void> {
  const whole = completion(request, reply);
  const chunk = (delta: unknown, finishReason: string | null = null) => ({
    id: whole.id,
    object: "chat.completion.chunk",
    created: whole.created,
    model: request.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const emit = (data: unknown) =>
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  emit(chunk({ role: "assistant", content: "" }));
  if (reply.delayMs && !(await waitForReply(response, reply.delayMs))) return;
  if (response.destroyed) return;
  const call = whole.choices[0].message.tool_calls?.[0];
  if (call) {
    emit(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: "" },
          },
        ],
      }),
    );
    // Arguments cross chunk boundaries, exercising the actual SDK's accumulator.
    for (
      let offset = 0;
      offset < call.function.arguments.length;
      offset += 17
    ) {
      emit(
        chunk({
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: call.function.arguments.slice(offset, offset + 17),
              },
            },
          ],
        }),
      );
    }
  } else {
    for (const text of (reply.text ?? "").match(/.{1,12}/gs) ?? []) {
      if (response.destroyed) return;
      emit(chunk({ content: text }));
      await delay(2);
    }
  }
  emit(chunk({}, call ? "tool_calls" : "stop"));
  emit({ ...chunk({}), choices: [], usage: whole.usage });
  response.end("data: [DONE]\n\n");
}

export async function createFakeModel(options: FakeModelOptions = {}) {
  const requests: CompletionRequest[] = [];
  const requestHeaders: Record<string, string | string[] | undefined>[] = [];
  const models = options.models ?? ["fixture-chat", "fixture-coder"];
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method === "GET" &&
        (request.url === "/v1/models" || request.url === "/api/tags")
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            request.url === "/api/tags"
              ? { models: models.map((name) => ({ name, model: name })) }
              : {
                  object: "list",
                  data: models.map((id) => ({
                    id,
                    object: "model",
                    owned_by: "integration-fixture",
                  })),
                },
          ),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end("Unknown fixture endpoint");
        return;
      }
      let body = "";
      for await (const part of request) {
        body += part.toString();
        if (body.length > 2_000_000)
          throw new Error("Fixture request exceeds 2 MB");
      }
      const parsed = JSON.parse(body) as CompletionRequest;
      if (!models.includes(parsed.model)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Fixture model not found",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      requests.push(parsed);
      requestHeaders.push({ ...request.headers });
      const reply = await (options.respond ?? fixtureReply)(
        parsed,
        requests.length,
      );
      if (parsed.stream) await streamCompletion(response, parsed, reply);
      else {
        if (reply.delayMs && !(await waitForReply(response, reply.delayMs)))
          return;
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(completion(parsed, reply)));
      }
    } catch (error) {
      if (!response.headersSent)
        response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind TCP");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    baseUrl: `${url}/v1`,
    requests,
    requestHeaders,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
