import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Parent Dot only: share an existing completed worker file upon an explicit user request. Supply its childTaskId, a relative workspace path (or a guest /workspace/ or /artifacts/ path), and the authorized requesting message ID. A completion review can use that exact worker's originating request. Returns attachment metadata, never file contents.",
  inputSchema: z.object({
    sourceTaskId: z.string().min(1).max(160),
    path: z.string().min(1).max(4096),
    requestMessageId: z.string().min(1).max(160),
  }),
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
});
