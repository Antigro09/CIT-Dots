import type { LanguageModelMiddleware } from "ai";
import { latestComputerScreenshot } from "./computer-context";

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
  options: { computer?: boolean; computerReadOnly?: boolean } = {},
): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      const tools = params.tools
        ?.filter((tool) =>
          isDotCoordinator
            ? tool.type === "function" && coordinatorTools.has(tool.name)
            : tool.type !== "function" ||
              (!parentOnlyTools.has(tool.name) &&
                (tool.name !== "computer" || options.computer === true)),
        )
        .map((tool) =>
          tool.type === "function" &&
          tool.name === "computer" &&
          options.computerReadOnly
            ? {
                ...tool,
                description:
                  "Inspect the owning Dot's graphical desktop with a screenshot. This read-only worker cannot send mouse or keyboard input.",
                inputSchema: {
                  type: "object" as const,
                  properties: {
                    action: { type: "string" as const, const: "screenshot" },
                  },
                  required: ["action"],
                  additionalProperties: false,
                },
              }
            : tool,
        );
      const choice = params.toolChoice;
      const unavailableChoice =
        choice?.type === "tool" &&
        !tools?.some(
          (tool) => tool.type === "function" && tool.name === choice.toolName,
        );
      return {
        ...params,
        prompt: latestComputerScreenshot(params.prompt),
        tools,
        ...(unavailableChoice ? { toolChoice: { type: "auto" as const } } : {}),
      };
    },
  };
}
