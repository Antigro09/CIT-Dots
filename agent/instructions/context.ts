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
        content: [`Assigned role: ${context.role}.`, context.instructions]
          .filter(Boolean)
          .join("\n\n"),
      });
    },
  },
});
