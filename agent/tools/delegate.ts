import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Start a specialist work session under the same workspace policy and root budget. Use coder for coding, files, commands and computer tasks; investigator for chat assistance or research; reviewer for checks. Set wait false to return its childTaskId immediately and continue the parent conversation while it works. Waiting completion returns childTaskId, status and result including deliverable paths.",
  inputSchema: z.object({
    role: z.enum(["coder", "investigator", "reviewer"]),
    prompt: z.string().min(1),
    title: z.string().optional(),
    wait: z.boolean().optional(),
  }),
  async task(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
