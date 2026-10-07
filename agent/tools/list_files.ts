import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description: "List files in the approved task workspace.",
  inputSchema: z.object({ path: z.string().optional() }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
