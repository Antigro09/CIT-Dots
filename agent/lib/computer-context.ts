import type { LanguageModelMiddleware } from "ai";

type ModelPrompt = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];
type ImageLocation = {
  message: number;
  part: number;
  outputPart?: number;
};
type ToolResult = Extract<
  Extract<ModelPrompt[number], { role: "tool" }>["content"][number],
  { type: "tool-result" }
>;

const returnedFilesHeading = "Files returned by the preceding tool results:";
const omittedScreen = {
  type: "text" as const,
  text: "Earlier desktop screenshot omitted; inspect the latest screen.",
};

/** Reduce only computer screenshots before the provider serializes image bytes. */
export function latestComputerScreenshot(prompt: ModelPrompt): ModelPrompt {
  const images: ImageLocation[] = [];
  let returnedFiles: boolean[] = [];
  for (const [messageIndex, message] of prompt.entries()) {
    if (message.role === "system") {
      returnedFiles = [];
      continue;
    }
    if (message.role === "user") {
      // Eve's .chat adapter moves hydrated tool files into this user message.
      // Match the preceding result markers in order to retain file provenance.
      if (
        message.content[0]?.type === "text" &&
        message.content[0].text === returnedFilesHeading
      ) {
        let fileIndex = 0;
        for (const [partIndex, part] of message.content.entries()) {
          if (part.type !== "file") continue;
          if (returnedFiles[fileIndex] && part.mediaType === "image/png")
            images.push({ message: messageIndex, part: partIndex });
          fileIndex++;
        }
      }
      returnedFiles = [];
      continue;
    }
    if (message.role !== "tool") returnedFiles = [];
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== "tool-result" || part.output.type !== "content")
        continue;
      for (const [outputIndex, output] of part.output.value.entries()) {
        if (
          part.toolName === "computer" &&
          output.type === "file" &&
          output.mediaType === "image/png"
        )
          images.push({
            message: messageIndex,
            part: partIndex,
            outputPart: outputIndex,
          });
        if (
          message.role === "tool" &&
          output.type === "text" &&
          /^Attached file .+ \(.+\) follows this tool result\.$/.test(
            output.text,
          )
        )
          returnedFiles.push(
            part.toolName === "computer" &&
              output.text ===
                "Attached file desktop.png (image/png) follows this tool result.",
          );
      }
    }
  }
  if (images.length < 2) return prompt;
  const obsolete = new Set(
    images
      .slice(0, -1)
      .map((image) =>
        [image.message, image.part, image.outputPart ?? "file"].join(":"),
      ),
  );
  const pruneResult = (
    part: ToolResult,
    messageIndex: number,
    partIndex: number,
  ): ToolResult => {
    if (part.output.type !== "content") return part;
    return {
      ...part,
      output: {
        ...part.output,
        value: part.output.value.map((output, outputIndex) =>
          obsolete.has(`${messageIndex}:${partIndex}:${outputIndex}`)
            ? omittedScreen
            : output,
        ),
      },
    };
  };
  // Copy the model projection; keep the durable history and sandbox refs intact.
  return prompt.map((message, messageIndex) => {
    if (message.role === "system") return message;
    if (message.role === "user")
      return {
        ...message,
        content: message.content.map((part, partIndex) =>
          obsolete.has(`${messageIndex}:${partIndex}:file`)
            ? omittedScreen
            : part,
        ),
      };
    if (message.role === "assistant")
      return {
        ...message,
        content: message.content.map((part, partIndex) =>
          part.type === "tool-result"
            ? pruneResult(part, messageIndex, partIndex)
            : part,
        ),
      };
    return {
      ...message,
      content: message.content.map((part, partIndex) =>
        part.type === "tool-result"
          ? pruneResult(part, messageIndex, partIndex)
          : part,
      ),
    };
  });
}
