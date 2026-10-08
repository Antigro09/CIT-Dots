# Ubuntu 26.04 workstation setup

Run the application as your normal desktop user. The three application services and a separately managed model server run on this PC. The initial hardware planning baseline is at least 48 GB total VRAM and 128 GB RAM; choose models after confirming the actual cards and available memory.

## Prerequisites

1. Install **Node 24** from a trusted distribution or [Node.js](https://nodejs.org/en/download). Check `node --version` and `npm --version`. The application's SQLite API requires the supported Node release.
2. Install Git and Python 3. Python is only needed by the archive helper, not for the TypeScript agent runtime.
3. Install [Docker Engine for Ubuntu](https://docs.docker.com/engine/install/ubuntu/) and arrange access to the Docker daemon for the application user. Check `docker version` and `docker run --rm hello-world`. The assistant's coding commands use Docker; GPU inference is a separate service.
4. Install **Ollama or LM Studio**, load a model and start its local server. Follow [local model setup](local-models.md).
5. For NVIDIA acceleration, install a compatible host driver and verify `nvidia-smi`. GPU containers additionally require NVIDIA Container Toolkit and a successful passthrough check. See [hardware and CUDA guidance](hardware.md).

Ubuntu's default Python interpreter is not the runtime for this application. If adding vLLM later, isolate its Python/PyTorch/CUDA versions in a pinned inference container or supported virtual environment.

## Install and configure

From the checkout:

```bash
cp .env.example .env
chmod 600 .env
npm ci
docker build -t cit-dots-sandbox:latest sandbox
docker build -t cit-dots-desktop:latest -f desktop/Dockerfile .
npm run dev
```

Use an existing `.env` rather than replacing it on subsequent setup. The services use these default addresses:

| Service              | Address                     | Role                                             |
| -------------------- | --------------------------- | ------------------------------------------------ |
| Web interface        | `http://127.0.0.1:3000`     | Chat, projects, workers, goals and configuration |
| Control service      | `http://127.0.0.1:4318`     | Application state and task dispatch              |
| Eve worker           | `http://127.0.0.1:4319`     | Agent execution and workflow callbacks           |
| Ollama, if chosen    | `http://127.0.0.1:11434/v1` | Compatible model API                             |
| LM Studio, if chosen | `http://127.0.0.1:1234/v1`  | Compatible model API                             |

The broker generates `.cit-data/internal-token` with private file permissions when no `CIT_INTERNAL_TOKEN` is set. Keep this file and `.env` private. The browser communicates through the Next server; it does not receive the internal service token. The normal local-model configuration does not require a paid API key.

`CIT_DATA_DIR` selects application storage and defaults to `.cit-data` under the checkout. Preserve that directory and `.eve/.workflow-data`. Choose a stable checkout path for a workstation with active workflows. Application storage must sit outside any project registered for coding to avoid recursive snapshots.

## Set up your Dots and their computers

The application creates Pip as the primary Dot. You can rename it, change its personality and pet appearance, and select its default model. Its primary status cannot change and it cannot be removed. Additional Dots can be created and removed; each has separate conversations, work, memories and notifications. Local model profiles and registered projects are shared resources.

Selecting a Dot opens its persistent main conversation, with its pet/name, computer status, activity and output files alongside it. Meaningful progress, results and questions from child workers and scheduled work also appear there. The upper-right New chat button opens an empty conversation with a Chat/Work selector; both modes create independent sessions without a Dot. Independent chat cannot access a Dot's private memories or computer; independent work uses its approved project workspace. Removing an extra Dot retains these independent sessions and original source projects.

Select a Dot, open Computer and choose Start. The desktop is a real Ubuntu 26.04/Xfce session streamed through TigerVNC/noVNC, with a browser, terminal and file manager. Use Stop when the computer is no longer needed. Its persistent directories are:

```text
.cit-data/dots/<dotId>/computer/home
.cit-data/dots/<dotId>/computer/workspace
.cit-data/dots/<dotId>/computer/artifacts
```

These paths are under `CIT_DATA_DIR` if you customize it. The interactive desktop and that Dot's file/command tools use the owned computer directories; temporary worker sessions do not create a new Dot identity. Stopping a desktop or closing the GUI keeps its files. Removing an extra Dot deletes its owned records and files after stopping its work, while retaining original registered source projects.

Inside both the sandbox runner and graphical desktop, the persistent home is `/home/cit`, the workspace is `/workspace` and artifacts are `/artifacts`. Keeping those paths stable allows home-installed tools, including virtual environments, to work across desktop start/stop.

Dot workers can read and write files and run commands in this computer. For graphical work, edit the worker's local model profile, enable **Use screenshots for computer tasks**, and run **Check connection**. A passing image and tool-call test enables screenshot-based computer use: coders can move, click, scroll, type, press keys and drag; investigators and reviewers can inspect screenshots. The parent Dot delegates those actions. Open Computer to watch its real cursor, select **Take control** to use the mouse and keyboard yourself, then **Give control back** to resume worker input.

Each desktop is a Docker container sharing the host kernel. It uses an internal network without outbound internet and does not receive the host Docker socket or GPU devices. The browser is available for local content; starting a desktop does not grant internet access. Approved network-enabled agent commands use the existing separate approval mechanism.

The noVNC connection uses a broker-managed loopback display relay into the owned container's private internal network. The broker does not automatically include its generated connection URL or password in model context or logs. The guest can read its own VNC authentication files, so the password is not hidden from code running inside that desktop. Do not share the connection URL as a public desktop link. A missing image or unavailable Docker daemon produces a setup/error state rather than a simulated live desktop.

The desktop image depends on the sandbox image built immediately before it. Build both before testing computer startup; a running broker does not download or build them automatically.

## Connect a model

Open the GUI's model configuration. Set the provider, compatible base URL and exact model ID. Use discovery to list installed models, then run the profile's connection check. The check exercises a streamed tool-call request; also complete a real task to verify valid arguments and the tool-result follow-up.

Start with a conservative context and inference concurrency. The GUI's task limit and inference limit serve different purposes: several tasks can be waiting while only one or two model requests execute. Run a plain chat before testing code.

## Register and test a project

Register an absolute local repository path in the GUI. Ask the assistant to inspect a file or perform a small change in its task workspace. Review the task's diff and command/test output. Applying the diff to the registered project is a distinct user action. A Docker image must contain the build tools needed by that project; prefetch the configured sandbox image before offline use.

The service user needs read access to the repository and sufficient disk space for workspaces. Existing source repositories are separate from application-state backups; retain their Git history and regular backups.

Committed Git projects use independent local clones with task branches and self-contained metadata, so `git status` and `git diff` work inside the container. Dirty source files are preserved in the initial snapshot. The source repository's refs and checkout are untouched until you explicitly apply changes. Unborn Git and non-Git projects use isolated copies.

## Keep it running

The development command is useful for editing the framework. For background workstation use, stop it, build and install the user services:

```bash
npm run build
node scripts/install-services.mjs
systemctl --user daemon-reload
systemctl --user enable --now cit-dots.target
node scripts/diagnostics.mjs
```

The installer records absolute paths to this checkout and the current Node executable. Rerun it if either location changes. See [the runbook](runbook.md) for desktop notices and the explicit linger setting needed for operation after logout or reboot.

## First-use acceptance

Confirm a real local-model reply, a successful tool-use task and a saved message after a service restart. Close the browser during a task, reopen it and inspect the result. Then perform the hardware checklist and backup/restore procedure. Dependency installation or a successful build alone does not establish those behaviors.

For each Dot computer, create a file, stop and restart its desktop, and verify that the file remains. Check that another Dot cannot access it. A successful noVNC page response alone does not prove that the graphical session, browser or terminal works.
