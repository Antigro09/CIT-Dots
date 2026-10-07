# Verification and practical limits

The framework's integration checks use a deterministic local OpenAI-compatible HTTP fixture. It can return controlled text and tool calls so state transitions, delegation, approvals, error handling and replay behavior can be tested reproducibly. It is not a downloaded language model and does not establish model reasoning quality or GPU performance.

The default application database starts empty. GUI screenshot fixtures, when used, belong in a separate temporary test database. Screenshots from those fixtures demonstrate layout and UI states; they must not be described as completed real-model work.

## Application checks

Use the repository scripts from its root:

```bash
npm run typecheck
npm test
npm run build
npm run test:all
npm run test:gui
```

GUI tests require Chromium. `CIT_CHROMIUM_PATH` selects an installed executable; otherwise Playwright uses its downloaded browser. `test:all` enables actual Docker checks, production Eve approval recovery after SIGKILL, and an end-to-end broker/Eve/Docker/delegation/approval workflow. Build the application and `cit-dots-sandbox:latest` image first. Run a real model turn afterward to assess your chosen model's behavior.

The completed validation run passed **44 of 44 tests with no skips** under `npm run test:all`, using the production Eve runtime, a deterministic local provider and real Docker execution. `npm run typecheck`, `npm run build` and `npm run test:gui` also passed. The ordinary `npm test` command does not enable all optional Eve and Docker checks; use `test:all` for that coverage.

## Operational checks performed during implementation

- `npm run start` launched the built GUI, broker and Eve worker together on loopback. The GUI and snapshot endpoint returned HTTP 200, with broker, worker and Docker health checks passing.
- Generated service units passed `systemd-analyze verify`. The cloud container has no functioning user systemd manager, so installation/startup under a real Ubuntu graphical session remains a workstation check.
- An isolated SQLite/workflow/workspace backup and restore preserved records and files, retained a safe relative symlink, excluded runtime credential files and refused overwrite and archive path traversal.
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

Real Ollama/LM Studio model reasoning and GPU inference were **not tested here**; no local language model or GPU device was available in the development environment. Throughput, memory capacity and model autonomy quality remain unmeasured until these checks are run. See [the hardware guide](hardware.md) for the provisional sizing and acceptance checklist.
