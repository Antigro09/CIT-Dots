# Workstation hardware and model sizing

The initial planning baseline is **at least 48 GB total VRAM and 128 GB system RAM**, with sufficient NVMe storage for models, repositories and backups. This is provisional sizing for local agents, not a guarantee that a particular model, context length or number of simultaneous agents will fit.

Confirm the GPU's full product name and VRAM before selecting a production model. RTX A6000, RTX 6000 Ada and RTX PRO 6000 Blackwell are different cards. The proposed two RTX 6000 PRO cards have not been tested by this project. Do not assume their interconnect, GPU memory, power budget or PCIe topology from the abbreviated name.

## Placement options for two GPUs

| Profile                           | GPU placement                                                             | Use when                                                        |
| --------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Separate services                 | A model server on each GPU, assigned using stable GPU UUIDs               | The coordinator and coding models each fit on one card          |
| One shared service                | The inference server spreads one model across both cards                  | A model is too large for one card                               |
| Shared model with a request queue | One model handles coordinator and child requests with bounded concurrency | Consistent model behavior and lower resident memory matter most |

Two cards do not automatically provide one contiguous memory pool. Ollama documents that it loads a model onto one GPU when it fits and otherwise distributes it across available GPUs. vLLM offers tensor and pipeline parallelism; its current guide recommends considering pipeline parallelism for cards without NVLink. Benchmark on the actual workstation rather than assuming that splitting a model makes it twice as fast.

## Estimate memory before downloading

Weights alone require approximately:

`number of parameters × bytes per parameter`

For example, 70 billion parameters at BF16 require about 140 GB for weights before KV cache, activations, runtime buffers and fragmentation. Four-bit quantization starts near half a byte per parameter but adds metadata and runtime overhead. A mixture-of-experts model with 30B total and 3B active parameters still needs storage for roughly 30B weights.

Long context windows and parallel requests consume additional KV cache. Ollama documents that four parallel requests with a 2K context allocate the equivalent of an 8K context. The number of child agents should therefore be separate from the number of simultaneous inference requests. Start with a small request limit and 8K–16K context, measure workload quality and peak memory, then tune.

System RAM supports repositories, indexing, build jobs and CPU fallback. CPU fallback can keep a model runnable but may change latency substantially. Free disk space must also accommodate model downloads, caches, Docker images, generated workspaces and a backup outside the primary data directory.

## Resources for each Dot computer

Each running Ubuntu/Xfce desktop adds CPU and system-RAM use, browser processes and persistent disk files. The graphical containers use software display streaming and receive no GPU devices; inference runs in the separate local model service. Adding a Dot does not require another model copy, but additional simultaneous model requests still consume inference capacity.

The desktops share an OS image and the host kernel. Keep their per-container resource limits and the global task/inference limits conservative until actual browser and coding workloads are measured. Stop unused desktops to release running-process resources without deleting their owned files. Nothing local continues computing while the workstation is suspended or powered off.

## Ubuntu 26.04 and CUDA

Install a driver supported by the exact card and Ubuntu kernel. Verify the installed driver with `nvidia-smi` before adding a model server. If using GPU containers, verify NVIDIA Container Toolkit passthrough separately; Docker availability alone does not establish CUDA availability.

The supplied development environment has Ubuntu 26.04, Python 3.14.4 and GCC 15.2.0. These CPU development tools were verified; the environment does not establish GPU performance or a validated NVIDIA driver stack. The application's TypeScript services use Node 24 and do not require Python inference libraries.

Current vLLM documentation supports Python 3.10–3.13 and describes default CUDA 12.9 binaries, plus CUDA 12.8 and 13.0 variants. Its Blackwell guidance calls for CUDA 12.8 or newer. If adding vLLM, use a pinned inference container or a compatible isolated Python environment rather than Ubuntu 26.04's default Python. A container isolates library versions but still needs a compatible host driver.

## Workstation acceptance checklist

1. Record GPU model, UUID, VRAM, driver version, RAM and PCIe topology.
2. Verify inference runs on the intended GPU rather than falling back to CPU.
3. Test a normal response, a streamed response and a structured tool call with the chosen model.
4. Run a real coding task with a child session and inspect the generated diff and test output.
5. Measure peak GPU memory, prefill time and response latency at the configured context and concurrency limit.
6. Exercise cancellation, model-server failure, GUI closure and service restart.
7. After configuring startup, reboot and confirm stored tasks, messages and local memory remain available.
8. Start two Dot desktops, verify distinct private files, and measure RAM/CPU use while a representative agent task runs. Stop/restart a desktop and confirm its persistent files remain.

Record results for each tested profile. This project does not supply unmeasured token-per-second claims or promise that arbitrary models work.

## Sources and verification limits

- [Ollama GPU compatibility](https://github.com/ollama/ollama/blob/main/docs/gpu.mdx) explicitly lists RTX PRO 6000 Blackwell at compute capability 12.0.
- [Ollama concurrency and multi-GPU behavior](https://github.com/ollama/ollama/blob/main/docs/faq.mdx).
- [vLLM requirements](https://github.com/vllm-project/vllm/blob/main/docs/getting_started/installation/gpu.md) and [CUDA installation details](https://github.com/vllm-project/vllm/blob/main/docs/getting_started/installation/gpu.cuda.inc.md).
- [vLLM parallelism](https://github.com/vllm-project/vllm/blob/main/docs/serving/parallelism_scaling.md).
- [NVIDIA CUDA installation guide](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/index.html) for the current supported driver, compiler and OS matrix.

The official project repository documents above were inspected during implementation. NVIDIA's documentation domain was inaccessible from the development environment; the current Ubuntu 26.04 NVIDIA support matrix and the workstation's exact specifications require checking on the target machine.
