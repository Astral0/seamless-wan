#!/bin/sh
# seamless-wan: noVNC stack inside Alpine chroot
# Starts Xvfb + Openbox + x11vnc + websockify + Firefox

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
export DISPLAY=:1

# Start virtual framebuffer
Xvfb :1 -screen 0 1280x720x24 &

# Wait for Xvfb to be ready (xdpyinfo is more reliable than sleep)
tries=0
while [ $tries -lt 20 ]; do
    xdpyinfo -display :1 >/dev/null 2>&1 && break
    tries=$((tries + 1))
    sleep 0.5
done

# Start window manager, VNC server, websocket proxy, and browser
openbox &
x11vnc -display :1 -forever -nopw -shared -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 &
firefox-esr &

wait
