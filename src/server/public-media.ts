/** Screen bytes remain in the worker's private result, not public event logs. */
export function publicMedia(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("data:image/"))
    return "[Screen image omitted; open the computer to view its display.]";
  if (Array.isArray(value)) return value.map(publicMedia);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const image = [record.mimeType, record.mediaType].some(
    (type) => typeof type === "string" && type.startsWith("image/"),
  );
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !(image && ["data", "content"].includes(key)))
      .map(([key, child]) => [key, publicMedia(child)]),
  );
}
