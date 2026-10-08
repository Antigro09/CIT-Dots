const IMAGE_TOKENS = 4096;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Keep the latest screen in model context without counting PNG bytes as prose. */
export function prepareModelImages(messages: unknown[]): {
  messages: unknown[];
  estimatedTokens: number;
  imageCount: number;
} {
  let imageCount = 0;
  const next = messages
    .slice()
    .reverse()
    .map((message) => {
      if (!message || typeof message !== "object") return message;
      const record = message as Record<string, unknown>;
      if (!Array.isArray(record.content)) return record;
      const content = record.content
        .slice()
        .reverse()
        .map((part) => {
          if (!part || typeof part !== "object" || part.type !== "image_url")
            return part;
          if (imageCount)
            return {
              type: "text",
              text: "Earlier screenshot omitted; inspect the latest screen.",
            };
          const url = part.image_url?.url;
          if (
            typeof url !== "string" ||
            !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
          )
            throw new Error(
              "Computer images must be bounded inline PNG screenshots.",
            );
          const bytes = Buffer.from(
            url.slice("data:image/png;base64,".length),
            "base64",
          );
          if (
            bytes.length < 24 ||
            bytes.length > MAX_IMAGE_BYTES ||
            !bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.toString("ascii", 12, 16) !== "IHDR" ||
            !bytes.readUInt32BE(16) ||
            !bytes.readUInt32BE(20) ||
            bytes.readUInt32BE(16) > 8192 ||
            bytes.readUInt32BE(20) > 8192
          )
            throw new Error(
              "Computer screenshot dimensions or PNG size are invalid.",
            );
          imageCount++;
          return part;
        })
        .reverse();
      return { ...record, content };
    })
    .reverse();
  const textOnly = JSON.stringify(next, (key, value) =>
    key === "url" &&
    typeof value === "string" &&
    value.startsWith("data:image/")
      ? "[screen image]"
      : value,
  );
  return {
    messages: next,
    imageCount,
    estimatedTokens: Math.ceil(textOnly.length / 3) + imageCount * IMAGE_TOKENS,
  };
}
