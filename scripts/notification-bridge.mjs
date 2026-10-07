import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { controlUrl, internalToken, loadRuntimeEnv } from "./runtime-env.mjs";

loadRuntimeEnv();
const baseUrl = controlUrl();
const seconds = Number(process.env.CIT_NOTIFICATION_POLL_SECONDS || 10);
if (!Number.isFinite(seconds) || seconds < 2 || seconds > 300) {
  throw new Error("CIT_NOTIFICATION_POLL_SECONDS must be between 2 and 300.");
}
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => abort.abort());
let previousStatus = "";
const handedToDesktop = new Set();

function status(message) {
  if (previousStatus === message) return;
  previousStatus = message;
  console.log(message);
}

async function request(path, options = {}) {
  const token = await internalToken();
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)]),
  });
  if (!response.ok)
    throw new Error(`Local inbox returned HTTP ${response.status}.`);
  return response;
}

function escapedBody(value) {
  return String(value || "")
    .slice(0, 4000)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function popup(item) {
  return new Promise((resolve, reject) => {
    const args = [
      "--app-name=CIT Dots",
      "--urgency=normal",
      "--",
      String(item.title || "CIT Dots").slice(0, 160),
      escapedBody(item.body),
    ];
    const process = spawn("notify-send", args, { stdio: "ignore" });
    process.on("error", () =>
      reject(new Error("notify-send is unavailable. Install libnotify-bin.")),
    );
    process.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Desktop notification service is unavailable. Inbox items remain queued.",
            ),
          ),
    );
  });
}

while (!abort.signal.aborted) {
  try {
    const response = await request("/api/local/inbox?undelivered=1");
    const payload = await response.json();
    const items = Array.isArray(payload)
      ? payload
      : payload.items || payload.inbox;
    if (!Array.isArray(items))
      throw new Error("Local inbox returned an unexpected response.");
    const pendingIds = new Set(items.map((item) => item.id));
    for (const id of handedToDesktop)
      if (!pendingIds.has(id)) handedToDesktop.delete(id);
    for (const item of items) {
      if (abort.signal.aborted) break;
      if (!item.id || item.delivered) continue;
      if (!handedToDesktop.has(item.id)) {
        await popup(item);
        handedToDesktop.add(item.id);
      }
      await request(
        `/api/local/inbox/${encodeURIComponent(item.id)}/delivered`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      handedToDesktop.delete(item.id);
    }
    status(
      "Notification bridge connected; waiting for meaningful inbox items.",
    );
  } catch (error) {
    if (abort.signal.aborted) break;
    // Avoid printing request headers, notification content or environment values.
    const message =
      error.code === "ENOENT"
        ? "Start the broker to create the internal token."
        : error.message === "fetch failed"
          ? "Local broker is unavailable."
          : error.message;
    status(`Notification bridge waiting: ${message}`);
  }
  await delay(seconds * 1000, undefined, { signal: abort.signal }).catch(
    () => {},
  );
}
