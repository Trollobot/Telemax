#!/bin/sh
# Starts as root ONLY to fix ownership of the mounted state volume, then drops to
# the unprivileged node user before running the bridge. Why not a static `USER node`
# in the Dockerfile: existing installs have a root-owned ./data (the pre-0.4.9
# container wrote it as root), and an auto-update runs the OLD update.sh — which
# can't chown for the new image — so the fix has to live INSIDE the container and
# run on every start. The bridge itself (which parses untrusted messenger input and
# renders attacker-supplied Lottie in Chromium --no-sandbox) never runs as root.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/.data 2>/dev/null || true
  exec setpriv --reuid node --regid node --init-groups node dist/server.mjs
fi
exec node dist/server.mjs
