import type { LanguageModelMiddleware } from "ai";

const coordinatorTools = new Set([
  "delegate",
  "report_progress",
  "ask_user",
  "remember",
  "forward_file",
  "send_worker_message",
  "task_status",
  // Eve manages these durable task controls without calling the broker.
  "task_wait",
  "task_cancel",
]);
const parentOnlyTools = new Set([
  "forward_file",
  "send_worker_message",
  "task_status",
]);

export function coordinationToolPolicy(
  isDotCoordinator: boolean,
): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      const tools = params.tools?.filter((tool) =>
        isDotCoordinator
          ? tool.type === "function" && coordinatorTools.has(tool.name)
          : tool.type !== "function" || !parentOnlyTools.has(tool.name),
      );
      const choice = params.toolChoice;
      const unavailableChoice =
        choice?.type === "tool" &&
        !tools?.some(
          (tool) => tool.type === "function" && tool.name === choice.toolName,
        );
      return {
        ...params,
        tools,
        ...(unavailableChoice ? { toolChoice: { type: "auto" as const } } : {}),
      };
    },
  };
}
