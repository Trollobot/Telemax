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
# Heartbeat FIRST, before the early exit: it is how the bridge knows an auto-updater actually serves
# THIS directory. Without it the «Обновить» button cheerfully wrote a marker nobody would ever read
# (an install set up without root, or — before the dispatcher — a second bridge on the same host) and
# the promised completion message never came.
mkdir -p data
date -u +%Y-%m-%dT%H:%M:%SZ > data/watcher-heartbeat 2>/dev/null || true

MARKER="data/update-requested"
[ -f "$MARKER" ] || exit 0

mkdir -p data
# Don't let two update.sh runs overlap. A build+restart can take several minutes,
# longer than this watcher's 1-minute tick — and the bot's "Обновить" button can be
# pressed again (via a fresh /version) while the first run is still going. The
# in-flight run already pulls latest main, so a second concurrent run would just
# race its docker build. flock -n makes the later tick bow out; the marker is
# consumed either way so it doesn't pile up.
exec 9> data/update.lock
if ! flock -n 9; then
  rm -f "$MARKER"
  exit 0
fi
rm -f "$MARKER"

# Overwrite, not append: every run dumps the full image-build output (~100-200 KB),
# and only the LAST run's log is ever useful for diagnostics — appending just
# grew the file forever.
./update.sh > data/update.log 2>&1
