import { z } from "zod";

const coordinate = z.number().int().min(0).max(8191);
const duration = z.number().int().min(0).max(1500).optional();
const position = { x: coordinate.optional(), y: coordinate.optional() };
const key = z
  .string()
  .min(1)
  .max(32)
  .refine(
    (value) =>
      /^[A-Za-z0-9]$/.test(value) ||
      /^(?:F(?:[1-9]|1[0-9]|2[0-4])|Return|Enter|Escape|Esc|Tab|BackSpace|Delete|Insert|Home|End|Prior|Next|Page_Up|Page_Down|Up|Down|Left|Right|space|Space|Control_L|Control_R|Ctrl|Control|Shift_L|Shift_R|Shift|Alt_L|Alt_R|Alt|Super_L|Super_R|Super|Meta|equal|plus|minus|underscore|period|comma|slash|backslash|semicolon|colon|apostrophe|quotedbl|bracketleft|bracketright|braceleft|braceright|grave|asciitilde)$/.test(
        value,
      ),
    "Unsupported desktop key name.",
  );

/** Model arguments describe input events only; they never contain a command or path. */
export const computerActionSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("screenshot") }).strict(),
    z
      .object({
        action: z.literal("move"),
        x: coordinate,
        y: coordinate,
        durationMs: duration,
      })
      .strict(),
    z
      .object({
        action: z.literal("click"),
        ...position,
        button: z.enum(["left", "middle", "right"]).optional(),
        count: z.union([z.literal(1), z.literal(2)]).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("scroll"),
        ...position,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("type"),
        text: z
          .string()
          .min(1)
          .max(4000)
          .refine(
            (text) => !text.includes("\0"),
            "Text cannot contain a null character.",
          ),
      })
      .strict(),
    z
      .object({ action: z.literal("key"), keys: z.array(key).min(1).max(5) })
      .strict(),
    z
      .object({
        action: z.literal("drag"),
        x: coordinate,
        y: coordinate,
        toX: coordinate,
        toY: coordinate,
        durationMs: duration,
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    if (
      ("x" in input && input.x !== undefined) !==
      ("y" in input && input.y !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Pointer positions require both x and y.",
      });
  });

export type ComputerAction = z.infer<typeof computerActionSchema>;
export interface ComputerCursor {
  width: number;
  height: number;
  cursor: { x: number; y: number };
}
export interface ComputerResult extends ComputerCursor {
  action: ComputerAction["action"];
  image?: { mimeType: "image/png"; data: string };
}
export type ComputerControlMode = "agent" | "human";
export interface ComputerControlStatus {
  mode: ComputerControlMode;
  updatedAt: string;
  /** Human admission is requested, but injected input cleanup is not confirmed. */
  pending?: boolean;
}
