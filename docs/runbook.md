# Operations and recovery

The web interface, control service and Eve worker are separate processes. Their user systemd target keeps them running after the browser closes. The local model service must also remain available. Started Dot computers are separate Docker containers; closing the GUI or restarting the broker keeps their persistent files, and the broker reattaches its owned desktops.

## Start, stop and inspect

After building and installing the service files:

```bash
systemctl --user start cit-dots.target
systemctl --user stop cit-dots.target
systemctl --user status cit-dots-broker.service cit-dots-eve.service cit-dots-web.service
node scripts/diagnostics.mjs
```

Use one process manager at a time. Stop `npm run dev` or `npm run start` before starting the user services on the same ports. Use Pause to stop new dispatch and Cancel for tasks that should not continue; stopping a process is also a recovery event for its unfinished work.

Logs are available through `journalctl --user -u cit-dots-broker.service`, with the same pattern for `cit-dots-eve.service` and `cit-dots-web.service`. Logs and workflow data can contain private task content. The diagnostics helper reports versions, GPU availability, state-path existence, health, service status and owned desktop IDs/status; it omits tokens, desktop connection URLs, environment dumps and conversation contents.

The supplied services restart failed processes. A healthy HTTP listener does not prove that the model service or Docker toolchain is ready. Run the application's connection and tool-use checks after changing those dependencies.

## Continue after logout or reboot

Installing and enabling the user services keeps them available under the user manager. For the user manager to start at boot and survive logout, explicitly enable linger on the target workstation:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" --property=Linger
```

This is a separate machine configuration step; the installer never changes it automatically. Disable it with `sudo loginctl disable-linger "$USER"` when that behavior is no longer wanted. Suspend, hibernation and power-off pause local computation regardless of linger.

Configure the model server's own startup independently, then reboot and confirm the agent services, model endpoint and persisted state. Desktop popups require a logged-in graphical session even when background work can run headlessly.

Use Computer → Stop for each unneeded Dot desktop. Its home, workspace and artifacts remain on disk. Removing an extra Dot stops its work and computer before deleting its own records/files; independent chat/work sessions and original source projects remain. The primary Dot cannot be removed.

## Ubuntu desktop notifications

Install `libnotify-bin` to provide `notify-send`, then enable the bridge:

```bash
sudo apt install libnotify-bin
systemctl --user enable --now cit-dots-notifications.service
```

The bridge polls the durable inbox; polling does not create notices. It hands pending progress, results, questions and errors to the desktop daemon, then acknowledges delivery. Inbox read state is separate, so seeing a popup does not mark its message as read in the application.

If the broker, token file, `notify-send` or desktop daemon is unavailable, items remain queued for a later attempt. An acknowledgment failure is retried without another popup while that bridge process remains alive. A crash after a popup but before acknowledgment can cause another popup on restart: delivery is at least once. “Delivered” means accepted by the desktop daemon, not proof that the user read it.

The bridge runs under the graphical user session. Its log reports availability changes and omits notification content. It does not add recurring check-ins or voice listening.

## Back up state

Stop every Dot computer through the GUI before stopping the application services. Then stop all writers, including manually started development processes. Stopping `cit-dots.target` alone does not stop graphical computers. The helper refuses backup or restore while the configured broker or Eve ports are open or this installation owns a running graphical desktop. If Dot computer state exists and Docker is unavailable, it refuses because it cannot verify that desktops are stopped.

```bash
systemctl --user stop cit-dots.target
node scripts/state-backup.mjs backup /absolute/backup/location/cit-dots-state.tar.gz
systemctl --user start cit-dots.target
```

Choose a new archive filename each time; an existing archive is never overwritten. The archive includes a standalone SQLite snapshot containing Dot and independent-session records, coding workspace files, Eve's local workflow data, and each valid Dot's `computer` and `computer-state` directories. Computer home, workspace, artifacts and task/baseline metadata are preserved. It excludes each Dot's `desktop` directory, `.env*`, `internal-token`, `vnc-password`, model weights and original registered source repositories. Back up source repositories separately.

Runtime credential files are excluded; arbitrary secrets pasted into a chat or source file can still be part of private state. Store archives with appropriate access controls. The helper creates private archives and checks SQLite integrity. It rejects state symlinks that lead outside their copied state directory rather than silently producing an archive that cannot be safely restored.

## Restore without overwriting current work

Stop the application. Restore first into new, empty directories:

```bash
node scripts/state-backup.mjs restore /absolute/backup/location/cit-dots-state.tar.gz \
  --data-dir /absolute/recovery/cit-data \
  --workflow-dir /absolute/recovery/workflow-data
```

The helper validates the archive format, entry paths, symlinks and SQLite integrity before copying state. Dot entries are restricted to `data/dots/<valid-dot-id>/computer` and `computer-state`; desktop lifecycle/authentication metadata is refused. Symlinks must stay within their own copied state subtree, including their own Dot. The helper refuses nonempty destinations and never restores environment files, the internal token or desktop passwords.

Keep current data aside until recovery is verified. To use recovered state in the original installation, move the restored application directory into the configured `CIT_DATA_DIR` and the restored workflow directory into `.eve/.workflow-data`, with all application processes and owned graphical desktops stopped. Reconfigure `.env` separately. The broker regenerates its internal token if needed; a restored Dot computer generates fresh desktop credentials when started. Old noVNC URLs are not recovery credentials.

Retain the tested package lockfile, Eve release, repository paths and source repositories for the first recovery attempt. Git worktree pointers and authored workflow generations may depend on them. Inspect interrupted tasks before retrying actions that could already have changed files or produced an external effect. An application-state restore is not a promise that every unfinished workflow can resume across framework or source changes.

## Upgrade and remove services

Before upgrading, complete or cancel active tasks and create an offline backup. Install the locked dependencies, build, run the relevant checks, then restart the target. Verify a real model turn and a coding tool before re-enabling unattended goals.

To disable startup:

```bash
systemctl --user disable --now cit-dots.target
systemctl --user disable --now cit-dots-notifications.service
```

Remove the five generated `cit-dots*` unit files from the user systemd configuration directory if no longer needed, then run `systemctl --user daemon-reload`. Application data remains until deliberately removed.
