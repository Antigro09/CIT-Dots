/** Dot conversations contain prose; implementations remain in worker sessions. */
export const WITHHELD_DOT_CODE =
  "That response included code, so I kept it out of our conversation. I can delegate the implementation to a worker and share its files when you ask.";

export function dotProse(content: string): string {
  const code =
    /```|~~~|<\/?(?:script|style|html|body|div|pre|code)(?:\s|>)/i.test(
      content,
    ) ||
    /^(?:\s*)(?:(?:import|export)\s+(?:[\w{*]|default)|(?:const|let|var)\s+[\w$]+\s*=|(?:async\s+)?function\s*[\w$]*\s*\(|(?:async\s+)?def\s+\w+\s*\(|class\s+\w+(?:\s*[:({]|\s+extends)|(?:from\s+[\w.]+\s+import)|(?:#include\s*[<"]|#!\/)|(?:SELECT\s+.+\s+FROM\s|CREATE\s+TABLE\s)|(?:\$\s+\S)|(?:npm|pnpm|pip|sudo|apt|curl|git|python3?)\s+(?:install|run|test|clone|push|pull|commit|fetch|build|-[\w-]+)\b)/im.test(
      content,
    ) ||
    /^\s*(?:[\w.$]+\([^\n]*\);|(?:print|console\.(?:log|error|warn)|assert|return)\s*\([^\n]*\)\s*;?|[{}]\s*;?|@@\s+[-+]\d|(?:diff --git|--- a\/|\+\+\+ b\/))\s*.*$/m.test(
      content,
    );
  return code ? WITHHELD_DOT_CODE : content.replace(/`([^`\n]+)`/g, "$1");
}
