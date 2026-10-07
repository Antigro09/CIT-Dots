import {
  Client,
  type InputResponse,
  type MessageStreamEvent,
} from "eve/client";
import { config, internalToken } from "./config";

export interface WorkerEvent {
  type: "text" | "tool" | "completed" | "failed" | "waiting" | "usage";
  text?: string;
  error?: string;
  input?: unknown;
  result?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  cursor?: number;
}
function client(taskId: string): Client {
  return new Client({
    host: config.eveUrl,
    auth: { bearer: () => internalToken() },
    headers: { "x-cit-task-id": taskId },
    redirect: "error",
  });
}
export async function createWorkerSession(taskId: string): Promise<string> {
  const { session } = await client(taskId).sessions.create();
  return session.state.sessionId;
}
export async function sendWorkerMessage(
  sessionId: string,
  taskId: string,
  message: string,
): Promise<void> {
  await client(taskId)
    .sessions.attach(sessionId)
    .send(message, { turnPolicy: "queue" });
}
export async function cancelWorkerSession(
  sessionId: string,
  taskId: string,
): Promise<void> {
  await client(taskId).sessions.attach(sessionId).cancel();
}
export async function answerWorkerInput(
  sessionId: string,
  taskId: string,
  inputResponses: readonly InputResponse[],
): Promise<void> {
  await client(taskId).sessions.attach(sessionId).respond(inputResponses);
}
export async function workerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${config.eveUrl}/eve/v1/health`, {
      signal: AbortSignal.timeout(2500),
      redirect: "error",
    });
    const payload = (await response.json()) as { ok?: boolean };
    return response.ok && payload.ok === true;
  } catch {
    return false;
  }
}
function translate(
  event: MessageStreamEvent,
): Omit<WorkerEvent, "cursor"> | undefined {
  const data = event.data as unknown as Record<string, unknown>;
  switch (event.type) {
    case "message.appended":
      return { type: "text", text: String(data.messageDelta ?? "") };
    case "actions.requested":
      return { type: "tool", input: data };
    case "action.result":
      return { type: "tool", result: data };
    case "step.completed": {
      const usage = data.usage as Record<string, unknown> | undefined;
      return {
        type: "usage",
        usage: {
          inputTokens: Number(usage?.inputTokens ?? 0),
          outputTokens: Number(usage?.outputTokens ?? 0),
        },
      };
    }
    case "turn.waiting":
      return { type: "waiting", result: data };
    case "input.requested":
      return { type: "waiting", input: data };
    case "turn.completed":
      return { type: "completed" };
    case "turn.failed":
    case "session.failed":
      return {
        type: "failed",
        error: String(data.message ?? "Worker execution failed."),
      };
    case "turn.cancelled":
      return { type: "failed", error: "Worker turn was canceled." };
    default:
      return undefined;
  }
}
export async function* streamWorkerSession(
  sessionId: string,
  taskId: string,
  after = 0,
  signal?: AbortSignal,
): AsyncGenerator<WorkerEvent> {
  let cursor = after;
  const session = client(taskId).sessions.attach(sessionId);
  for await (const event of session.stream({ startIndex: after, signal })) {
    cursor += 1;
    const projected = translate(event);
    // Checkpoint every raw event so recovery never loses its durable position.
    yield {
      ...(projected ?? { type: "tool", result: { event: event.type } }),
      cursor,
    };
    if (projected?.type === "completed" || projected?.type === "failed") return;
  }
  // A socket ending is not a successful turn; the broker resumes this cursor.
}
