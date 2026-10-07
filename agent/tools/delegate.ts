import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Delegate independent work to a child specialist under the same workspace policy and root budget.",
  inputSchema: z.object({
    role: z.enum(["coder", "investigator", "reviewer"]),
    prompt: z.string().min(1),
    title: z.string().optional(),
  }),
  async task(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
