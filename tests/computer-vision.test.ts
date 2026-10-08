import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { createApp } from "../src/server/api";
import { Broker, type WorkerClient } from "../src/server/broker";
import { internalToken } from "../src/server/config";
import { prepareModelImages } from "../src/server/model-images";
import { probeModel } from "../src/server/models";
import type { ModelProfile, Task } from "../src/shared/types";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S8AAAAASUVORK5CYII=";
const imagePart = (base64 = PNG) => ({
  type: "image_url",
  image_url: { url: `data:image/png;base64,${base64}` },
});

async function localProvider(t: test.TestContext, imageReply: string | number) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const hasImage = JSON.stringify(body.messages).includes('"image_url"');
    if (hasImage && typeof imageReply === "number") {
      response.writeHead(imageReply, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: "This model rejects image inputs." }),
      );
      return;
    }
    const delta = hasImage
      ? { content: imageReply }
      : body.tools
        ? {
            tool_calls: [
              {
                index: 0,
                function: { name: "cit_probe", arguments: '{"value":"ok"}' },
              },
            ],
          }
        : { content: "Ready." };
    if (body.stream === false) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: delta }] }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function profile(baseUrl: string, visionEnabled = true): ModelProfile {
  return {
    id: "vision-model",
    createdAt: "2026-10-07T12:00:00.000Z",
    updatedAt: "2026-10-07T12:00:00.000Z",
    name: "Local vision fixture",
    provider: "lmstudio",
    baseUrl,
    modelId: "fixture",
    contextWindow: 32768,
    maxOutputTokens: 2048,
    temperature: 0,
    visionEnabled,
  };
}

test("the model connection probe verifies a real image before enabling desktop vision", async (t) => {
  const provider = await localProvider(t, "The square is red.");
  const checked = await probeModel(profile(provider.baseUrl));
  assert.equal(checked.status, "ready");
  assert.equal(checked.capabilities?.tools, true);
  assert.equal(checked.capabilities?.vision, true);
  assert.equal(provider.requests.length, 2);
  const imageRequest = provider.requests.find((body) =>
    JSON.stringify(body.messages).includes('"image_url"'),
  );
  assert.ok(imageRequest);
  const encoded = JSON.stringify(imageRequest).match(
    /data:image\/png;base64,([A-Za-z0-9+/=]+)/,
  )?.[1];
  assert.ok(encoded, "Vision must be probed using PNG pixels.");
  const bytes = Buffer.from(encoded, "base64");
  assert.equal(bytes.readUInt32BE(16), 64);
  assert.equal(bytes.readUInt32BE(20), 64);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT")
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(idat));
  assert.deepEqual([...pixels.subarray(0, 4)], [0, 255, 0, 0]);
});

test("a local model can retain working chat and tools when it rejects image inputs", async (t) => {
  const provider = await localProvider(t, 400);
  const checked = await probeModel(profile(provider.baseUrl));
  assert.equal(checked.status, "ready");
  assert.equal(checked.capabilities?.streaming, true);
  assert.equal(checked.capabilities?.tools, true);
  assert.equal(checked.capabilities?.vision, false);
  assert.match(checked.error ?? "", /vision|image/i);
});

test("an incorrect image answer does not mark a text model as vision capable", async (t) => {
  const provider = await localProvider(t, "The square is blue.");
  const checked = await probeModel(profile(provider.baseUrl));
  assert.equal(checked.status, "ready");
  assert.equal(checked.capabilities?.tools, true);
  assert.equal(checked.capabilities?.vision, false);
  assert.match(checked.error ?? "", /vision|image|red/i);
});

test("ordinary model profiles do not send a vision probe unless the user enables it", async (t) => {
  const provider = await localProvider(t, 400);
  const checked = await probeModel(profile(provider.baseUrl, false));
  assert.equal(checked.status, "ready");
  assert.equal(checked.capabilities?.tools, true);
  assert.notEqual(checked.capabilities?.vision, true);
  assert.equal(provider.requests.length, 1);
  assert.equal(
    JSON.stringify(provider.requests).includes('"image_url"'),
    false,
  );
});

test("repeated desktop observations retain only the latest screen and estimate pixels separately from base64 text", () => {
  // The broker checks the PNG envelope rather than interpreting screenshot pixels.
  const large = Buffer.concat([
    Buffer.from(PNG, "base64"),
    Buffer.alloc(1500000),
  ]).toString("base64");
  const prepared = prepareModelImages([
    { role: "user", content: [imagePart()] },
    { role: "assistant", content: "I inspected the previous screen." },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect the changed screen." },
        imagePart(large),
      ],
    },
  ]);
  assert.equal(prepared.imageCount, 1);
  assert.ok(prepared.estimatedTokens < 10000);
  const messages = prepared.messages as {
    role: string;
    content:
      { type: string; text?: string; image_url?: { url: string } }[] | string;
  }[];
  assert.ok(Array.isArray(messages[0].content));
  assert.equal(messages[0].content[0].type, "text");
  assert.match(messages[0].content[0].text ?? "", /earlier|latest/i);
  assert.ok(Array.isArray(messages[2].content));
  assert.equal(
    messages[2].content[1].image_url?.url,
    `data:image/png;base64,${large}`,
  );
});

test("model image preparation refuses remote URLs and invalid or oversized screenshot payloads", () => {
  for (const url of [
    "https://example.invalid/screenshot.png",
    "file:///etc/passwd",
    "data:image/png;base64,bm90IGFuIGltYWdl",
    `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString("base64")}`,
  ])
    assert.throws(() =>
      prepareModelImages([
        { role: "user", content: [{ type: "image_url", image_url: { url } }] },
      ]),
    );
});

test("a large desktop screenshot survives the authenticated model proxy within a 32k context budget", async (t) => {
  const provider = await localProvider(t, "red");
  const directory = await mkdtemp(join(tmpdir(), "cit-vision-proxy-"));
  const worker: WorkerClient = {
    async workerHealth() {
      return false;
    },
    async createWorkerSession() {
      return "unused";
    },
    async sendWorkerMessage() {},
    async cancelWorkerSession() {},
    async *streamWorkerSession() {},
  };
  const broker = new Broker({
    worker,
    config: { dataDir: directory, tickMs: 60000 },
  });
  const model = broker.store.insert<ModelProfile>("models", {
    ...profile(provider.baseUrl),
    capabilities: { streaming: true, tools: true, vision: true },
  });
  broker.updateSettings({ defaultModelProfileId: model.id });
  const session = broker.createSession({ kind: "chat", dotId: null });
  const task = broker.addUserMessage(session.id, {
    content: "Inspect the current screen.",
  }).task;
  const app = createApp({ broker });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    await broker.stop();
    broker.store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const large = Buffer.concat([
    Buffer.from(PNG, "base64"),
    Buffer.alloc(1500000),
  ]).toString("base64");
  const response = await fetch(
    `${url}/api/internal/model/${task.id}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${internalToken(broker.config)}`,
      },
      body: JSON.stringify({
        stream: true,
        messages: [
          { role: "user", content: [imagePart()] },
          { role: "assistant", content: "Earlier screen inspected." },
          { role: "user", content: [imagePart(large)] },
        ],
      }),
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /red/);
  assert.equal(provider.requests.length, 1);
  const messages = provider.requests[0].messages as { content: unknown }[];
  assert.equal(
    JSON.stringify(messages).split('"type":"image_url"').length - 1,
    1,
  );
  const completed = broker.store.require<Task>("tasks", task.id);
  assert.ok((completed.tokenUsage ?? 0) > 0);
  assert.ok((completed.tokenUsage ?? 0) < 32768);
  assert.equal(completed.steps, 1);
});
