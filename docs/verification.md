# Verification and practical limits

The framework's integration checks use a deterministic local OpenAI-compatible HTTP fixture. It can return controlled text and tool calls so state transitions, delegation, approvals, error handling and replay behavior can be tested reproducibly. It is not a downloaded language model and does not establish model reasoning quality or GPU performance.

The default application database creates only the permanent primary Dot and initial settings; it contains no demo conversations or completed tasks. GUI screenshot fixtures, when used, belong in a separate temporary test database. Screenshots from those fixtures demonstrate layout and UI states; they must not be described as completed real-model work.

## Application checks

Use the repository scripts from its root:

```bash
npm run typecheck
npm test
npm run build
npm run test:all
CIT_TEST_DESKTOP=1 npm run test:gui
```

GUI tests require Chromium. `CIT_CHROMIUM_PATH` selects an installed executable; otherwise Playwright uses its downloaded browser. `CIT_TEST_DESKTOP=1` enables real graphical-desktop interaction in the GUI suite. `test:all` enables actual Docker desktops and commands, production Eve approval recovery after SIGKILL, and an end-to-end broker/Eve/Docker/delegation/approval workflow. Build the application, `cit-dots-sandbox:latest` and `cit-dots-desktop:latest` images first. The combined suite runs test files serially to bound peak disk use, particularly with Docker's copy-based `vfs` storage driver. Run a real model turn afterward to assess your chosen model's behavior.

On **October 7, 2026**, `npm run test:all` passed **105 of 105 tests**, with **zero failures and zero skips**, in 127.6 seconds. This run used production Eve, actual Docker execution and graphical desktops, and a deterministic local model provider. The desktop-enabled GUI suite passed **3 of 3 tests**; type checking, the production build and formatting checks also passed. The desktop lifecycle suite's **5 of 5** and live desktop command integration's **1 of 1** targeted checks are included in the full-suite coverage. The ordinary `npm test` command does not enable all optional Eve and Docker checks; use `test:all` for that coverage.

The coordinator checks cover nonblocking delegation, same-session steering and queued follow-ups, delivery-ID races, durable private output checkpoints, worker ownership through retries and user replies, and automatic result review. They also verify that recognizable code stays in worker sessions, only requested files are shared, downloads preserve immutable binary bytes, and empty or whitespace-only background reviews remain quiet. A production Eve check confirms that queue and steer deliveries reach the existing session with authoritative delivery identities. The full stack check runs the Dot coordinator, coder and reviewer through production Eve and actual Docker execution, and confirms that the parent is offered coordination tools rather than filesystem or command tools.

The real desktop image used Ubuntu 26.04, Xfce 4.20, TigerVNC 1.15, noVNC 1.6 and Epiphany 49.2. Desktop validation exercised the VNC password challenge over the actual WebSocket display and confirmed visible terminal, file-manager and browser windows. It checked the non-root guest, read-only OS, absence of the Docker socket, blocked outbound networking and configured 2-CPU/4-GB/512-PID limits. Reattach retained the same container, stop/start preserved private files, and an extra Dot remained separate. Foreign Docker resources were refused.

Live command tests verified the shared persistent home/workspace/artifacts, a Python virtual environment usable across sandbox and desktop execution, and display-session command execution. Timeout, cancellation and broker recovery cleaned job descendants, including detached double-forked processes, without stopping the desktop or replaying an interrupted command. These are actual Docker process checks, not model reasoning tests.

The GUI checked an authenticated noVNC canvas, typed a command into the real graphical terminal and read its output file through the Dot API. The GUI also checks that the Dot conversation renders prose without code blocks, worker and independent Work sessions retain code rendering, and requested files download with the correct names and binary bytes. The updated screenshots show the saved Dot conversation and identity/output card, independent Chat/Work sessions, and the live desktop. Conversation content still comes from the deterministic provider fixture.

## Operational checks performed during implementation

- `npm run start` launched the built GUI, broker and Eve worker together on loopback. The GUI and snapshot endpoint returned HTTP 200, with broker, worker and Docker health checks passing.
- Generated service units passed `systemd-analyze verify`. The cloud container has no functioning user systemd manager, so installation/startup under a real Ubuntu graphical session remains a workstation check.
- Three automated backup fixtures passed for the Dot update: restore preserved Dot records, independent-session ownership, private computer files, computer task metadata and workflow state; runtime/desktop credentials stayed excluded. The checks also refused nonempty destinations, running owned desktops, unverifiable Docker state, unapproved archive paths and cross-Dot symlinks. Docker lifecycle detection in these fixtures uses a controlled executable, not a real desktop.
- A bridge fixture verified authenticated inbox polling, one popup, retry after an acknowledgment failure, delivery acknowledgment, escaped body text and logs without credential or notification contents. The fixture substituted `notify-send`; a real Ubuntu desktop daemon remains a workstation check.

These operational fixtures use temporary directories outside the default database. They do not install services, enable linger or modify workstation driver settings.

## Checks required on the target PC

1. Verify the exact GPU specification, host driver and inference placement.
2. Discover and load a real model in Ollama or LM Studio.
3. Confirm streamed chat, valid tool arguments and a tool-result follow-up.
4. Execute a representative coding task in Docker and review its diff/test evidence.
5. Close the GUI while work runs, then reopen it and inspect persisted progress and results.
6. Exercise approval, cancellation, model-server failure and restart behavior.
7. Test the real desktop bridge, optional linger startup and an offline backup/restore.
8. Start two real Dot graphical computers, use their terminal/browser/file manager, stop/restart them and verify private file persistence and isolation. Test an agent command inside a live desktop. The available agent tools do not include automated screen/mouse/keyboard control.
9. Open New chat, confirm the empty Chat/Work selector, and create independent sessions in both modes. Confirm delegated and scheduled Dot updates/questions appear in its saved main conversation, without changing the independent sessions' ownership.

Real Ollama/LM Studio model reasoning and GPU inference were **not tested here**; no local language model or GPU device was available in the development environment. Throughput, memory capacity and model autonomy quality remain unmeasured until these checks are run. See [the hardware guide](hardware.md) for the provisional sizing and acceptance checklist.
