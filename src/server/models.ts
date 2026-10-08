import type { ModelProfile } from "../shared/types";

const VISION_PROBE_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";

export function validateBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP model endpoint without credentials or query parameters.",
    );
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname))
    throw new Error(
      "Model servers must use a loopback address on this workstation.",
    );
  return url.toString().replace(/\/$/, "");
}
export async function discoverModels(
  baseUrl: string,
): Promise<{ id: string }[]> {
  const endpoint = validateBaseUrl(baseUrl);
  const response = await fetch(`${endpoint}/models`, {
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Model server returned ${response.status}.`);
  const body = (await response.json()) as { data?: { id: string }[] };
  return (body.data || [])
    .filter((model) => typeof model.id === "string")
    .map((model) => ({ id: model.id }));
}
export async function probeModel(
  profile: ModelProfile,
): Promise<Partial<ModelProfile>> {
  try {
    validateBaseUrl(profile.baseUrl);
    let response = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(90000),
      redirect: "error",
      body: JSON.stringify({
        model: profile.modelId,
        messages: [
          {
            role: "user",
            content:
              'Call cit_probe with value "ok". This is a harmless connection test.',
          },
        ],
        max_tokens: 128,
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "cit_probe",
              description: "Harmless connection check",
              parameters: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          },
        ],
        tool_choice: "auto",
      }),
    });
    if ([400, 422].includes(response.status)) {
      await response.body?.cancel();
      response = await fetch(`${profile.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(90000),
        redirect: "error",
        body: JSON.stringify({
          model: profile.modelId,
          messages: [{ role: "user", content: "Reply with Ready." }],
          max_tokens: 16,
          stream: true,
        }),
      });
    }
    if (!response.ok)
      throw new Error(
        `Model server returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    const body = await response.text();
    let tools = false,
      streaming = false;
    const calls = new Map<number, { name: string; arguments: string }>();
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      streaming = true;
      try {
        const chunk = JSON.parse(line.slice(6));
        for (const choice of chunk.choices || [])
          for (const call of choice.delta?.tool_calls || []) {
            const index = call.index || 0;
            const previous = calls.get(index) || { name: "", arguments: "" };
            previous.name += call.function?.name || "";
            previous.arguments += call.function?.arguments || "";
            calls.set(index, previous);
          }
      } catch {
        /* Ignore keepalive frames. */
      }
    }
    for (const call of calls.values())
      try {
        if (
          call.name === "cit_probe" &&
          JSON.parse(call.arguments).value === "ok"
        )
          tools = true;
      } catch {}
    if (!streaming)
      throw new Error("Server did not return a supported streaming response.");
    let vision = false;
    let visionError = "";
    if (profile.visionEnabled) {
      try {
        const check = await fetch(`${profile.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(90000),
          redirect: "error",
          body: JSON.stringify({
            model: profile.modelId,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "What is the main color of this image? Reply with only the color name.",
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${VISION_PROBE_IMAGE}`,
                    },
                  },
                ],
              },
            ],
            max_tokens: 32,
            stream: false,
          }),
        });
        if (!check.ok)
          throw new Error(`Image request returned ${check.status}.`);
        const result = (await check.json()) as {
          choices?: { message?: { content?: unknown } }[];
        };
        const answer = result.choices?.[0]?.message?.content;
        vision = typeof answer === "string" && /\bred\b/i.test(answer);
        if (!vision)
          throw new Error("The model did not identify the test image's color.");
      } catch (error) {
        visionError = `Screenshot test did not pass: ${(error as Error).message}`;
      }
    }
    return {
      status: "ready",
      capabilities: { streaming, tools, vision },
      lastCheckedAt: new Date().toISOString(),
      error: tools
        ? visionError
        : "This model can chat, but its tool-call test did not pass.",
    };
  } catch (error) {
    return {
      status: "error",
      capabilities: { streaming: false, tools: false },
      lastCheckedAt: new Date().toISOString(),
      error: String((error as Error).message),
    };
  }
}

export class InferenceGate {
  private active = 0;
  private waiting: {
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }[] = [];
  constructor(private limit: () => number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("Inference canceled.");
    if (this.active < this.limit()) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: undefined as (() => void) | undefined,
      };
      waiter.abort = () => {
        this.waiting = this.waiting.filter((item) => item !== waiter);
        reject(new Error("Inference canceled."));
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
    });
    return () => this.release();
  }
  private release() {
    this.active = Math.max(0, this.active - 1);
    while (this.waiting.length && this.active < this.limit()) {
      const waiter = this.waiting.shift()!;
      if (waiter.signal?.aborted) continue;
      if (waiter.abort)
        waiter.signal?.removeEventListener("abort", waiter.abort);
      this.active++;
      waiter.resolve();
    }
  }
  get pending() {
    return this.waiting.length;
  }
}
