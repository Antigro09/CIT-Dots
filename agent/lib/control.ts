import { config, internalToken } from "../../src/server/config";

export interface WorkerContext {
  taskId: string;
  role: string;
  isDotCoordinator: boolean;
  dot?: { id: string; name: string; personality: string } | null;
  userMessages?: { id: string; content: string }[];
  workers?: {
    id: string;
    role: string;
    title: string;
    status: string;
    sessionId: string;
  }[];
  instructions: string;
  model: {
    modelId: string;
    baseUrl: string;
    contextWindow: number;
    maxOutputTokens: number;
    temperature: number;
    vision?: boolean;
  };
  messages: { role: string; content: string }[];
  memory: string;
}
export function requireTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new Error("A trusted CIT broker task identity is required.");
  return value;
}
export async function controlRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(new URL(path, config.controlUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${internalToken()}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    redirect: "error",
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(
      payload.error ?? `Control service returned ${response.status}.`,
    );
  return payload;
}
export async function workerContext(taskId: unknown): Promise<WorkerContext> {
  return controlRequest(
    `/api/internal/worker-context?taskId=${encodeURIComponent(requireTaskId(taskId))}`,
  );
}
