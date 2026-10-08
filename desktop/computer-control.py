"""Trusted, bounded X11 input and PNG capture for one owned desktop.

The broker invokes this file with literal argv, never a shell. Input events share
the same X server as noVNC, so humans and workers see the same application state.
"""

import base64
import io
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw
from Xlib import X, XK, display
from Xlib.ext import xtest

JOBS = Path("/tmp/cit-computer-actions")
HELPER = "/opt/cit/computer-control.py"
JOB_ID = re.compile(r"^[a-f0-9]{32}$")
ALIASES = {
    "Ctrl": "Control_L", "Control": "Control_L", "Shift": "Shift_L",
    "Alt": "Alt_L", "Super": "Super_L", "Meta": "Super_L",
    "Enter": "Return", "Esc": "Escape", "Space": "space",
    "Page_Up": "Prior", "Page_Down": "Next",
}
KEY_NAME = re.compile(
    r"^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Return|Escape|Tab|BackSpace|Delete|Insert|Home|End|Prior|Next|Up|Down|Left|Right|space|Control_[LR]|Shift_[LR]|Alt_[LR]|Super_[LR]|equal|plus|minus|underscore|period|comma|slash|backslash|semicolon|colon|apostrophe|quotedbl|bracketleft|bracketright|braceleft|braceright|grave|asciitilde)$"
)


class Canceled(Exception):
    pass


def stop(_signum, _frame):
    raise Canceled("Computer action was canceled or reached its time limit.")


def start_ticks(pid):
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def state(connection):
    root = connection.screen().root
    geometry = root.get_geometry()
    pointer = root.query_pointer()
    return {"width": geometry.width, "height": geometry.height,
            "cursor": {"x": pointer.root_x, "y": pointer.root_y}}


def coordinate(value, limit):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < limit:
        raise ValueError("The requested pointer position is outside the desktop.")
    return value


def move(connection, target_x, target_y, duration_ms=300):
    current = state(connection)
    x = coordinate(target_x, current["width"])
    y = coordinate(target_y, current["height"])
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or not 0 <= duration_ms <= 1500:
        raise ValueError("Pointer motion must be between 0 and 1500 milliseconds.")
    start_x, start_y = current["cursor"]["x"], current["cursor"]["y"]
    count = max(1, duration_ms // 20)
    for index in range(1, count + 1):
        fraction = index / count
        xtest.fake_input(connection, X.MotionNotify,
                         x=round(start_x + (x - start_x) * fraction),
                         y=round(start_y + (y - start_y) * fraction))
        connection.sync()
        if duration_ms:
            time.sleep(duration_ms / count / 1000)


def command(arguments):
    # A fresh process group lets the cancellation handler stop typing immediately.
    process = subprocess.Popen(["xdotool", *arguments], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    try:
        _stdout, stderr = process.communicate(timeout=10)
        if process.returncode:
            raise RuntimeError(stderr.decode("utf8", errors="replace")[:1000])
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def screenshot(connection, result):
    width, height = result["width"], result["height"]
    if width > 4096 or height > 4096 or width * height > 12_000_000:
        raise ValueError("Resize the desktop to at most 4096 pixels per side before capture.")
    raw = connection.screen().root.get_image(0, 0, width, height, X.ZPixmap, 0xFFFFFFFF)
    # The image uses the 24-bit TrueColor visual configured by cit-start-desktop.
    image = Image.frombytes("RGB", (width, height), raw.data, "raw", "BGRX")
    x, y = result["cursor"]["x"], result["cursor"]["y"]
    arrow = [(x, y), (x, y + 23), (x + 6, y + 17), (x + 11, y + 27),
             (x + 16, y + 24), (x + 11, y + 14), (x + 20, y + 14)]
    ImageDraw.Draw(image).polygon(arrow, fill="#63e6be", outline="#111827", width=2)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    if encoded.tell() > 2 * 1024 * 1024:
        raise ValueError("The desktop screenshot is too large. Use a smaller display.")
    result["image"] = {"mimeType": "image/png", "data": base64.b64encode(encoded.getvalue()).decode("ascii")}


def run(job_id, encoded):
    if not JOB_ID.fullmatch(job_id):
        raise ValueError("Invalid action identifier.")
    request = json.loads(base64.b64decode(encoded, validate=True))
    action = request.get("action")
    if action not in {"screenshot", "move", "click", "scroll", "type", "key", "drag"}:
        raise ValueError("Unsupported computer action.")
    os.umask(0o077)
    JOBS.mkdir(mode=0o700, exist_ok=True)
    if JOBS.is_symlink():
        raise ValueError("Computer action records must use a real directory.")
    record = JOBS / (job_id + ".json")
    marker = JOBS / (job_id + ".canceled")
    if marker.exists():
        raise Canceled("This computer action was canceled before it started.")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(12)
    connection = None
    held_button = None
    normalized = []
    pressed_before = None
    created_record = False
    try:
        # The cancellation record is visible only after a cleanup handler exists.
        # Block delivery while publishing its exact identity, then honor a signal
        # inside this try/finally before any input reaches the X server.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
        try:
            with record.open("x", encoding="utf8") as handle:
                created_record = True
                json.dump({"pid": os.getpid(), "startTicks": start_ticks(os.getpid()), "jobId": job_id}, handle)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        if marker.exists():
            raise Canceled("This computer action was canceled before it started.")
        connection = display.Display()
        pressed_before = connection.query_keymap()
        if "x" in request or "y" in request:
            if "x" not in request or "y" not in request:
                raise ValueError("Pointer positions require both x and y.")
            move(connection, request["x"], request["y"], request.get("durationMs", 300))
        if action == "click":
            button = {"left": 1, "middle": 2, "right": 3}.get(request.get("button", "left"))
            count = request.get("count", 1)
            if button is None or count not in (1, 2) or isinstance(count, bool):
                raise ValueError("Invalid mouse click.")
            for _index in range(count):
                held_button = button
                xtest.fake_input(connection, X.ButtonPress, detail=button)
                connection.sync()
                time.sleep(0.04)
                xtest.fake_input(connection, X.ButtonRelease, detail=button)
                held_button = None
                connection.sync()
                if count == 2:
                    time.sleep(0.08)
        elif action == "scroll":
            button = {"up": 4, "down": 5, "left": 6, "right": 7}.get(request.get("direction"))
            amount = request.get("amount", 3)
            if button is None or isinstance(amount, bool) or not isinstance(amount, int) or not 1 <= amount <= 20:
                raise ValueError("Invalid scroll request.")
            for _index in range(amount):
                held_button = button
                xtest.fake_input(connection, X.ButtonPress, detail=button)
                xtest.fake_input(connection, X.ButtonRelease, detail=button)
                held_button = None
                connection.sync()
                time.sleep(0.02)
        elif action == "drag":
            held_button = 1
            xtest.fake_input(connection, X.ButtonPress, detail=1)
            connection.sync()
            move(connection, request["toX"], request["toY"], request.get("durationMs", 500))
            xtest.fake_input(connection, X.ButtonRelease, detail=1)
            held_button = None
            connection.sync()
        elif action == "type":
            text = request.get("text")
            if not isinstance(text, str) or not 1 <= len(text) <= 4000 or "\0" in text:
                raise ValueError("Typing requires between 1 and 4000 characters.")
            command(["type", "--clearmodifiers", "--delay", "1", "--", text])
        elif action == "key":
            keys = request.get("keys")
            if not isinstance(keys, list) or not 1 <= len(keys) <= 5:
                raise ValueError("A key request needs between 1 and 5 key names.")
            normalized = [ALIASES.get(key, key) if isinstance(key, str) else "" for key in keys]
            if not all(KEY_NAME.fullmatch(key) for key in normalized):
                raise ValueError("Unsupported desktop key name.")
            command(["key", "--clearmodifiers", "--", "+".join(normalized)])
        connection.sync()
        result = {"action": action, **state(connection)}
        if action == "screenshot":
            screenshot(connection, result)
        print(json.dumps(result), flush=True)
    finally:
        signal.alarm(0)
        if connection:
            if held_button:
                xtest.fake_input(connection, X.ButtonRelease, detail=held_button)
                connection.sync()
            if action in {"key", "type"}:
                # Cancellation between synthetic down/up events must not leave
                # a modifier held when a person takes over the desktop.
                for key in ("Control_L", "Control_R", "Shift_L", "Shift_R",
                            "Alt_L", "Alt_R", "Super_L", "Super_R"):
                    code = connection.keysym_to_keycode(XK.string_to_keysym(key))
                    if code:
                        xtest.fake_input(connection, X.KeyRelease, detail=code)
                if action == "key":
                    for key in normalized:
                        code = connection.keysym_to_keycode(XK.string_to_keysym(key))
                        if code:
                            xtest.fake_input(connection, X.KeyRelease, detail=code)
                # xdotool can be killed between a character's down/up events.
                # Query keycodes rather than keysyms, covering ordinary and
                # temporarily mapped Unicode keys without releasing old input.
                if pressed_before is not None:
                    pressed_now = connection.query_keymap()
                    for code in range(8, 256):
                        bit = 1 << (code % 8)
                        if pressed_now[code // 8] & bit and not pressed_before[code // 8] & bit:
                            xtest.fake_input(connection, X.KeyRelease, detail=code)
                connection.sync()
            connection.close()
        if created_record:
            record.unlink(missing_ok=True)


def cancel(job_id):
    if not JOB_ID.fullmatch(job_id):
        raise ValueError("Invalid action identifier.")
    os.umask(0o077)
    JOBS.mkdir(mode=0o700, exist_ok=True)
    if JOBS.is_symlink():
        raise ValueError("Computer action records must use a real directory.")
    marker = JOBS / (job_id + ".canceled")
    try:
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
    except FileExistsError:
        pass
    record = JOBS / (job_id + ".json")
    deadline = time.monotonic() + 1
    info = None
    while time.monotonic() < deadline:
        try:
            descriptor = os.open(record, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, encoding="utf8") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise ValueError("Computer action metadata must be a regular file.")
                contents = source.read(4097)
                if len(contents) > 4096:
                    raise ValueError("Computer action metadata is too large.")
                info = json.loads(contents)
            break
        except FileNotFoundError:
            # The marker also fences a delayed exec that has not registered.
            return
        except json.JSONDecodeError:
            time.sleep(0.025)
    if info is None:
        raise RuntimeError("Unable to confirm the computer action's cancellation identity.")
    process_descriptor = None
    try:
        pid = info["pid"]
        if not isinstance(pid, int) or pid < 2 or info.get("jobId") != job_id:
            raise ValueError("Computer action cancellation identity is invalid.")
        process_descriptor = os.pidfd_open(pid)
        if info.get("startTicks") != start_ticks(pid):
            raise ValueError("The computer action PID was reused; refusing to signal it.")
        arguments = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        if not (HELPER.encode() in arguments and b"run" in arguments and job_id.encode() in arguments):
            raise ValueError("The running process is not this trusted computer action.")
        signal.pidfd_send_signal(process_descriptor, signal.SIGTERM)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            exited = bool(select.select([process_descriptor], [], [], 0)[0])
            if exited and not record.exists():
                return
            time.sleep(0.02)
        raise RuntimeError("Unable to confirm computer input cleanup. The desktop remains view-only.")
    except (FileNotFoundError, ProcessLookupError) as error:
        if record.exists():
            raise RuntimeError("Computer input cleanup is uncertain. The desktop remains view-only.") from error
    finally:
        if process_descriptor is not None:
            os.close(process_descriptor)


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "run":
            run(sys.argv[2], sys.argv[3])
        elif len(sys.argv) == 3 and sys.argv[1] == "cancel":
            cancel(sys.argv[2])
        elif len(sys.argv) == 2 and sys.argv[1] == "cursor":
            connection = display.Display()
            try:
                print(json.dumps(state(connection)), flush=True)
            finally:
                connection.close()
        else:
            raise ValueError("Unsupported helper invocation.")
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
