import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Report a meaningful discovery or task progress to the user. Avoid routine check-ins.",
  inputSchema: z.object({ message: z.string().min(1) }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
