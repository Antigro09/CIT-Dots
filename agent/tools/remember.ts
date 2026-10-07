import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description: "Save useful stable local context for future tasks.",
  inputSchema: z.object({
    title: z.string().min(1),
    content: z.string().min(1),
  }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
