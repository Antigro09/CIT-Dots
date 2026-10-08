import { toolOutput, toolOutputPart, type ToolModelOutput } from "eve/tools";
import { z } from "zod";

const maximumImageBytes = 2 * 1024 * 1024;
const screenshot = z.object({
  action: z.literal("screenshot"),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  cursor: z.object({
    x: z.number().int().min(0).max(8191),
    y: z.number().int().min(0).max(8191),
  }),
  image: z.object({
    mimeType: z.literal("image/png"),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(maximumImageBytes / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }),
});

/** Preserve pixels as an image part instead of putting base64 in model text. */
export function computerModelOutput(output: unknown): ToolModelOutput {
  if (!output || typeof output !== "object" || !("image" in output))
    return toolOutput.json(output);
  const parsed = screenshot.safeParse(output);
  if (!parsed.success)
    return toolOutput.text(
      "The computer tool did not return a valid bounded PNG screenshot. No image is available for visual verification.",
    );
  const result = parsed.data;
  const bytes = Buffer.from(result.image.data, "base64");
  if (
    result.image.data.length % 4 !== 0 ||
    bytes.length > maximumImageBytes ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return toolOutput.text(
      "The computer tool returned invalid screenshot bytes. No image is available for visual verification.",
    );
  return toolOutput.content([
    toolOutputPart.text(
      `Current desktop screenshot: ${result.width} by ${result.height} pixels. Cursor at x=${result.cursor.x}, y=${result.cursor.y}. Use these screen pixel coordinates for the next action.`,
    ),
    toolOutputPart.file(result.image.data, {
      mediaType: "image/png",
      filename: "desktop.png",
    }),
  ]);
}
