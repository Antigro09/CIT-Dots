import { defineDynamic } from "eve";
import { defineInstructions } from "eve/instructions";
import { workerContext } from "../lib/control";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const context = await workerContext(
        ctx.session.auth.current?.attributes.taskId,
      );
      return defineInstructions({
        role: "user",
        content: [
          `Assigned role: ${context.role}.`,
          context.instructions,
          context.isDotCoordinator
            ? `Authorized user message references for requested file handoffs (current turn or this worker's originating request):\n${JSON.stringify(context.userMessages ?? [])}`
            : "",
          context.isDotCoordinator
            ? `Owned work sessions you can inspect and continue:\n${JSON.stringify(context.workers ?? [])}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    },
  },
});
