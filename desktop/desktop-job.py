#!/usr/bin/env python3
"""Bound a broker-issued shell job inside this Dot's Docker desktop."""
import json
import glob
import ctypes
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path


def start_ticks(pid):
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def save(filename, value):
    temporary = filename.with_suffix(".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(value, output)
    os.replace(temporary, filename)


def kill_group(record):
    pid = record["pid"]
    actual = start_ticks(pid)
    # A still-live leader must be the exact process that this wrapper started.
    if actual is not None and actual != record["startTicks"]:
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def children(pid):
    try:
        return [int(value) for value in Path(f"/proc/{pid}/task/{pid}/children").read_text().split()]
    except (OSError, ValueError):
        # Some supported kernels omit CONFIG_CHECKPOINT_RESTORE's children
        # file. The standard process stat table still exposes exact parents.
        result = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                if int(fields[1]) == pid:
                    result.append(int(entry.name))
            except (OSError, ValueError, IndexError):
                # A process can exit while the snapshot is being inspected.
                continue
        return result


def kill_descendants(pid):
    for child in children(pid):
        kill_descendants(child)
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass


def reap_descendants():
    # Subreaper adoption also captures setsid/double-fork descendants.
    for _ in range(100):
        kill_descendants(os.getpid())
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return
        # waitpid returning zero means a child still exists, even when it is
        # between adoption and its appearance in a /proc snapshot. Only ECHILD
        # proves that all descendants have been reaped.
        time.sleep(0.01)


def main():
    if len(sys.argv) < 3 or not re.fullmatch(r"[a-f0-9]{64}", sys.argv[2]):
        raise SystemExit("Invalid desktop operation key.")
    directory = Path("/tmp/cit-jobs")
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink():
        raise SystemExit("Desktop job directory must not be a symlink.")
    filename = directory / (sys.argv[2] + ".json")
    marker = directory / (sys.argv[2] + ".canceled")
    if sys.argv[1] == "cancel":
        try:
            descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(descriptor)
        except FileExistsError:
            pass
        try:
            descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor) as source:
                record = json.load(source)
        except FileNotFoundError:
            return 0
        if record.get("state") == "running" and start_ticks(record["pid"]) == record["startTicks"]:
            kill_group(record)
        return 0
    if sys.argv[1] != "run" or len(sys.argv) != 5:
        raise SystemExit("Expected run <operation> <seconds> <command> or cancel <operation>.")
    if marker.exists():
        return 130
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot bound desktop command descendants.")
    timeout = max(0.1, min(float(sys.argv[3]), 900))
    os.environ.update({"USER": "cit", "LOGNAME": "cit", "NSS_WRAPPER_PASSWD": "/tmp/cit-passwd", "NSS_WRAPPER_GROUP": "/tmp/cit-group", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS": "1", "WEBKIT_DISABLE_COMPOSITING_MODE": "1"})
    libraries = glob.glob("/usr/lib/*/libnss_wrapper.so")
    if libraries:
        os.environ["LD_PRELOAD"] = libraries[0]
    try:
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = Path("/tmp/cit-runtime/dbus-address").read_text().strip()
    except FileNotFoundError:
        raise SystemExit("The desktop session bus is not ready.")
    process = subprocess.Popen(["/bin/bash", "-c", sys.argv[4]], start_new_session=True)
    record = {"pid": process.pid, "startTicks": start_ticks(process.pid), "state": "running", "canceled": False}
    canceled = False
    timed_out = False
    exit_code = 1

    def cancel_signal(_signal, _frame):
        nonlocal canceled
        canceled = True
        kill_group(record)

    try:
        # Every operation after spawning the child is protected by cleanup,
        # including a full tmpfs or failure to publish the initial job record.
        save(filename, record)
        canceled = marker.exists()
        if canceled:
            kill_group(record)
        signal.signal(signal.SIGTERM, cancel_signal)
        signal.signal(signal.SIGINT, cancel_signal)
        try:
            exit_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_group(record)
            process.wait()
            exit_code = 124
    finally:
        # Background children cannot outlive their approved command invocation.
        kill_group(record)
        process.wait()
        reap_descendants()
        try:
            stored = json.loads(filename.read_text())
            canceled = canceled or stored.get("canceled", False)
        except (OSError, ValueError):
            pass
        record["state"] = "completed"
        record["canceled"] = canceled or marker.exists()
        try:
            save(filename, record)
        except OSError:
            # Guest programs can clear /tmp; exit semantics still belong to this
            # bounded process, rather than the optional guest job-state file.
            pass
    return 130 if record["canceled"] else 124 if timed_out else exit_code if exit_code >= 0 else 128 - exit_code


if __name__ == "__main__":
    sys.exit(main())
