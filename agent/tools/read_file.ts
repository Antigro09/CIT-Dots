import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description: "Read a text file in the approved task workspace.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
