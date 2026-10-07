# Local model endpoints

CIT-Dots calls an OpenAI-compatible HTTP endpoint supplied by a local model server. Run the model service independently of the web GUI. Ollama and LM Studio are the initial setup choices; vLLM and llama.cpp can be configured later when their endpoint and tool-call behavior pass the same checks.

## Ollama

Install Ollama using its [official Linux instructions](https://docs.ollama.com/linux), then download a model that fits the actual hardware and supports tool use. Configure local-only operation with `OLLAMA_NO_CLOUD=1` if cloud models and cloud features are unwanted. Ollama's usual compatible API address is `http://127.0.0.1:11434/v1`.

List available models without exposing credentials:

```bash
curl --fail --silent --show-error http://127.0.0.1:11434/v1/models
ollama ps
```

The configured model ID must match a downloaded model. A large model may need to warm up before the first response. Use `ollama ps` to inspect whether the model resides on the GPU, CPU or a mixture.

Ollama supports GPU selection through `CUDA_VISIBLE_DEVICES`; stable GPU UUIDs are preferable to numeric IDs. Its `keep_alive` parameter and server settings control model residency and concurrency. Keep the assistant's inference queue bounded even if the server supports more requests.

## LM Studio

Install [LM Studio](https://lmstudio.ai), download a suitable tool-capable model, load it, and start its local OpenAI-compatible server. Use the server address and exact model identifier shown by LM Studio; its usual compatible API address is `http://127.0.0.1:1234/v1`.

```bash
curl --fail --silent --show-error http://127.0.0.1:1234/v1/models
```

Keep LM Studio's inference service running while the assistant works. Closing the assistant's GUI does not imply that LM Studio itself stays available. For unattended use, configure LM Studio's supported background/headless server mode and verify recovery after login or reboot.

## Model capability checks

A successful `/v1/models` response proves connectivity and model discovery. It does not prove that a model can produce valid tool calls. Before unattended work, test:

1. Plain and streamed chat completion.
2. A tool call with the correct function name and valid JSON arguments.
3. A follow-up turn using the returned tool result.
4. Context sizing and simultaneous requests without out-of-memory failures.

Use the application's provider checks for initial discovery, then run a real assistant task. Some model servers require a particular chat template, tool parser or reasoning parser. If tool-call support fails, choose a compatible model/profile rather than accepting unvalidated generated shell text as a substitute.

## vLLM or llama.cpp later

The application can point at a separately configured compatible endpoint. vLLM automatic tool use requires `--enable-auto-tool-choice` and an appropriate `--tool-call-parser`; some models also need a matching chat template. llama.cpp supports a compatible server and CUDA backends, with explicit memory and GPU split settings. Pin the tested server release and model revision.

Use the [hardware guide](hardware.md) for Python/CUDA compatibility and two-GPU placement. Switching endpoints does not change the application's persistent task and memory storage.

## Offline operation

After downloading model weights, packages and required Docker images, local chat and supported local coding tasks can run without cloud model services. Model downloads, package installation, browser research and external messaging still require the network. The assistant does not gain those capabilities merely because a model supports tool calling.
