import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { defineAgent, defineDynamic } from "eve";
import { workerContext } from "./lib/control";
import { coordinationToolPolicy } from "./lib/tool-policy";
import { internalToken } from "../src/server/config";

export default defineAgent({
  defaultTools: false,
  tool: false,
  model: defineDynamic({
    events: {
      "step.started": async (_event, ctx) => {
        const context = await workerContext(
          ctx.session.auth.current?.attributes.taskId,
        );
        const provider = createOpenAICompatible({
          name: "cit-local",
          baseURL: context.model.baseUrl,
          apiKey: internalToken(),
        });
        return {
          model: wrapLanguageModel({
            model: provider.chatModel(context.model.modelId),
            middleware: coordinationToolPolicy(context.isDotCoordinator, {
              computer:
                !!context.dot &&
                context.model.vision === true &&
                context.role !== "coordinator" &&
                !context.isDotCoordinator,
              computerReadOnly: ["investigator", "reviewer"].includes(
                context.role,
              ),
            }),
          }),
          modelContextWindowTokens: context.model.contextWindow,
        };
      },
    },
  }),
  limits: { sessionTimeoutMs: false },
});
