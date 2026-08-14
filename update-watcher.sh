#!/usr/bin/env bash
# Runs every minute via the telemax-updater systemd timer (installed by
# setup.sh) — checks for the update-requested marker that /version's
# "Обновить" button writes, and if present, runs the real update. Lives
# entirely outside the container, so it keeps working even if the bridge
# itself is mid-restart, stuck, or crashed.
set -euo pipefail
cd "$(dirname "$0")"

# `data/`, NOT `.data/` — that's the container-internal path (docker-compose.yml
# mounts host `./data` there); this script runs on the host itself.
MARKER="data/update-requested"
[ -f "$MARKER" ] || exit 0
rm -f "$MARKER"

mkdir -p data
./update.sh >> data/update.log 2>&1
