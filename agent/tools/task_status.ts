import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Parent Dot only: inspect an existing specialist work session's status and available result. Use its childTaskId returned by delegate. Keep technical worker results private and summarize them in conversational prose; do not busy-poll unchanged work.",
  inputSchema: z.object({
    workerTaskId: z.string().min(1).max(160),
  }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
