import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Parent Dot only: send another prompt to an existing specialist work session while it is running or after it completes. Use steer for a correction applied at a safe execution boundary; use queue for a follow-up after the current turn. This preserves the worker's conversation and workspace rather than starting a new worker.",
  inputSchema: z.object({
    workerTaskId: z.string().min(1).max(160),
    message: z.string().min(1),
    mode: z.enum(["steer", "queue"]).default("queue"),
  }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
