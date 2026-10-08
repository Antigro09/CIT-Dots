# syntax=docker/dockerfile:1
FROM cit-dots-sandbox:latest
USER root
ENV DEBIAN_FRONTEND=noninteractive
# The optional managed-cloud CA is a build secret, never a runtime mount.
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    set -e; sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources; \
    if [ -f /run/secrets/proxy_ca ]; then \
      apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update; \
      apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca install -y --no-install-recommends xfce4 xfce4-terminal thunar tigervnc-standalone-server tigervnc-tools novnc websockify epiphany-browser dbus-x11 xauth x11-utils libnss-wrapper fonts-dejavu-core xdotool python3-xlib python3-pil; \
    else \
      apt-get update; \
      apt-get install -y --no-install-recommends xfce4 xfce4-terminal thunar tigervnc-standalone-server tigervnc-tools novnc websockify epiphany-browser dbus-x11 xauth x11-utils libnss-wrapper fonts-dejavu-core xdotool python3-xlib python3-pil; \
    fi && rm -rf /var/lib/apt/lists/*
# Install in one layer: copy-based Docker drivers otherwise duplicate the OS
# for every tiny helper file. This build-only source mount never reaches runtime.
RUN --mount=type=bind,source=desktop,target=/tmp/cit-desktop-source \
    install -m 755 /tmp/cit-desktop-source/start-desktop.sh /usr/local/bin/cit-start-desktop \
    && install -m 755 /tmp/cit-desktop-source/desktop-health.sh /usr/local/bin/cit-desktop-health \
    && install -d -m 755 /opt/cit \
    && install -m 644 /tmp/cit-desktop-source/desktop-job.py /opt/cit/desktop-job.py \
    && install -m 644 /tmp/cit-desktop-source/computer-control.py /opt/cit/computer-control.py \
    && install -m 644 /tmp/cit-desktop-source/cit-control.js /usr/share/novnc/cit-control.js \
    && sed -i 's|</body>|<script type="module" src="cit-control.js"></script></body>|' /usr/share/novnc/vnc.html \
    && mkdir -p /home/cit /workspace /artifacts /run/cit-secret
ENV HOME=/home/cit DISPLAY=:0 XAUTHORITY=/tmp/cit-vnc/Xauthority LANG=C.UTF-8 XDG_RUNTIME_DIR=/tmp/cit-runtime \
    LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1
# /workspace is inherited from cit-dots-sandbox.
EXPOSE 6080
HEALTHCHECK --interval=3s --timeout=3s --start-period=15s --retries=5 CMD ["/usr/local/bin/cit-desktop-health"]
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/cit-start-desktop"]
