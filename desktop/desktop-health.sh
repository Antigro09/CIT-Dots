#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:0 XAUTHORITY=/tmp/cit-vnc/Xauthority
xdpyinfo >/dev/null 2>&1
python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:6080/vnc.html", timeout=2).close()'
