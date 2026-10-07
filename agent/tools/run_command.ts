import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Run a command in the task sandbox. External network access requires approval.",
  inputSchema: z.object({
    command: z.string().min(1),
    network: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
