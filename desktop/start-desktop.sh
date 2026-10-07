#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p "$XDG_RUNTIME_DIR" /tmp/cit-vnc "$HOME/Desktop" "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
mkdir -p /tmp/.X11-unix /tmp/.ICE-unix
chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix
chmod 700 "$XDG_RUNTIME_DIR"

# Numeric host UIDs need a real passwd entry for Xfce and browser subprocesses.
guest_uid="$(id -u)"
guest_gid="$(id -g)"
printf 'cit:x:%s:%s:CIT Dots:/home/cit:/bin/bash\n' "$guest_uid" "$guest_gid" > /tmp/cit-passwd
printf 'cit:x:%s:\n' "$guest_gid" > /tmp/cit-group
export NSS_WRAPPER_PASSWD=/tmp/cit-passwd NSS_WRAPPER_GROUP=/tmp/cit-group
export LD_PRELOAD="$(find /usr/lib -name libnss_wrapper.so -print -quit)"
export USER=cit LOGNAME=cit

if [[ ! -s /run/cit-secret/vnc-password ]]; then
  echo 'The broker must mount a private VNC authentication secret.' >&2
  exit 1
fi
vncpasswd -f < /run/cit-secret/vnc-password > /tmp/cit-vnc/password
chmod 600 /tmp/cit-vnc/password

# Seed real desktop shortcuts once; keep user changes across stop/start.
if [[ ! -e "$HOME/Desktop/Terminal.desktop" ]]; then
  cat > "$HOME/Desktop/Terminal.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Terminal
Exec=xfce4-terminal --working-directory=/workspace
Icon=utilities-terminal
Terminal=false
EOF
fi
if [[ ! -e "$HOME/Desktop/Files.desktop" ]]; then
  cat > "$HOME/Desktop/Files.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Workspace files
Exec=thunar /workspace
Icon=system-file-manager
Terminal=false
EOF
fi
if [[ ! -e "$HOME/Desktop/Browser.desktop" ]]; then
  cat > "$HOME/Desktop/Browser.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Web browser
Exec=epiphany about:blank
Icon=web-browser
Terminal=false
EOF
fi
chmod +x "$HOME/Desktop/Terminal.desktop" "$HOME/Desktop/Files.desktop" "$HOME/Desktop/Browser.desktop"
if [[ ! -e "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml" && -e /etc/xdg/xfce4/panel/default.xml ]]; then
  cp /etc/xdg/xfce4/panel/default.xml "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
fi
if [[ ! -e "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml" ]]; then
  cat > "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0"><property name="general" type="empty"><property name="use_compositing" type="bool" value="false"/></property></channel>
EOF
fi

# The Docker container is the browser's outer sandbox. WebKit's nested namespace
# sandbox cannot run under Docker's dropped capabilities and default seccomp.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export XAUTHORITY=/tmp/cit-vnc/Xauthority
touch "$XAUTHORITY"
xauth -f "$XAUTHORITY" add :0 . "$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
Xtigervnc :0 -geometry 1440x900 -depth 24 -desktop 'CIT Dots' \
  -rfbauth /tmp/cit-vnc/password -localhost yes -SecurityTypes VncAuth \
  -AlwaysShared -AcceptSetDesktopSize=1 -nolisten tcp -auth "$XAUTHORITY" &
vnc_pid=$!
cleanup() {
  kill "${web_pid:-}" "${desktop_pid:-}" "$vnc_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
for attempt in {1..100}; do
  if xdpyinfo -display :0 >/dev/null 2>&1; then break; fi
  if ! kill -0 "$vnc_pid" 2>/dev/null; then exit 1; fi
  sleep 0.1
done
xdpyinfo -display :0 >/dev/null
dbus-run-session -- bash -c 'printf "%s\n" "$DBUS_SESSION_BUS_ADDRESS" > "$XDG_RUNTIME_DIR/dbus-address"; exec xfce4-session' &
desktop_pid=$!
websockify --web=/usr/share/novnc --heartbeat=30 6080 localhost:5900 &
web_pid=$!
set +e
wait -n "$vnc_pid" "$desktop_pid" "$web_pid"
exit_code=$?
exit "$exit_code"
