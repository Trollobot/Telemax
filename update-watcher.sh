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
# Overwrite, not append: every run dumps the full image-build output (~100-200 KB),
# and only the LAST run's log is ever useful for diagnostics — appending just
# grew the file forever.
./update.sh > data/update.log 2>&1
