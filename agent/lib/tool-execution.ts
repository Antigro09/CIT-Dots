import type { WorkflowStepToolContext, WorkflowToolContext } from "eve/tools";
import { sleep } from "workflow";
import { controlRequest, requireTaskId } from "./control";

type ToolReply = {
  result?: unknown;
  approval?: { id: string; prompt: string };
  childTaskId?: string;
  pending?: boolean;
};
type PendingReply = { status: string; result?: unknown; error?: string };

async function beginTool(
  ctx: WorkflowStepToolContext,
  input: Record<string, unknown>,
): Promise<ToolReply> {
  "use step";
  return controlRequest(
    "/api/internal/tool",
    {
      taskId: requireTaskId(ctx.session.auth.current?.attributes.taskId),
      sessionId: ctx.session.id,
      callId: ctx.callId,
      toolName: ctx.toolName,
      input,
    },
    ctx.abortSignal,
  );
}
async function readToolResult(
  ctx: WorkflowStepToolContext,
): Promise<PendingReply> {
  "use step";
  const taskId = requireTaskId(ctx.session.auth.current?.attributes.taskId);
  return controlRequest(
    `/api/internal/tool-result?taskId=${encodeURIComponent(taskId)}&callId=${encodeURIComponent(ctx.callId)}`,
    undefined,
    ctx.abortSignal,
  );
}
async function readChild(
  ctx: WorkflowStepToolContext,
  childTaskId: string,
): Promise<PendingReply> {
  "use step";
  return controlRequest(
    `/api/internal/children/${encodeURIComponent(childTaskId)}`,
    undefined,
    ctx.abortSignal,
  );
}
export async function runBrokerTool(
  input: Record<string, unknown>,
  ctx: WorkflowToolContext,
): Promise<unknown> {
  "use workflow";
  const initial = await beginTool(ctx, input);
  const cachedResult =
    initial.result && typeof initial.result === "object"
      ? (initial.result as { childTaskId?: string })
      : undefined;
  const childTaskId = initial.childTaskId ?? cachedResult?.childTaskId;
  if (childTaskId) {
    if (input.wait === false) return { childTaskId, status: "queued" };
    for (;;) {
      if (ctx.abortSignal.aborted) return { canceled: true };
      const child = await readChild(ctx, childTaskId);
      if (child.status === "completed")
        return {
          childTaskId,
          status: child.status,
          result: child.result ?? "Child completed.",
        };
      if (["failed", "canceled", "interrupted"].includes(child.status))
        return {
          childTaskId,
          status: child.status,
          error: child.error ?? "Child did not complete.",
        };
      await sleep("2s");
    }
  }
  if (!initial.approval && !initial.pending) return initial.result ?? null;
  for (;;) {
    if (ctx.abortSignal.aborted) return { canceled: true };
    const pending = await readToolResult(ctx);
    if (pending.status === "completed") return pending.result ?? null;
    if (pending.status === "denied")
      return {
        denied: true,
        reason: pending.error ?? "User declined the action.",
      };
    if (pending.status === "failed")
      return { error: pending.error ?? "Tool execution failed." };
    await sleep("2s");
  }
}
