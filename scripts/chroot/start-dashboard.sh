#!/bin/sh
# seamless-wan: web dashboard inside Alpine chroot
# Starts the Python dashboard server on port 8080

cd /opt/dashboard || exit 1
exec python3 server.py
