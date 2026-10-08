import { defineWorkflowTool } from "eve/tools";
import { computerActionSchema } from "../../src/shared/computer";
import { computerModelOutput } from "../lib/computer-output";
import { runBrokerTool } from "../lib/tool-execution";

export default defineWorkflowTool({
  description:
    "Vision worker only: inspect and operate the owning Dot's graphical Linux desktop. Start with screenshot to see the actual image, dimensions and cursor; act using screen pixel coordinates, then screenshot again to verify. Coder actions are screenshot, move, click, scroll, type, key and drag. Investigators and reviewers may only screenshot. Human takeover blocks input. This offline desktop does not grant network or external-action approval.",
  inputSchema: computerActionSchema,
  async execute(input, ctx) {
    "use workflow";
    return runBrokerTool(input, ctx);
  },
  toModelOutput: computerModelOutput,
});
