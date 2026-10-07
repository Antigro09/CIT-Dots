import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Write a file in the approved task workspace. Read existing files first.",
  inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
