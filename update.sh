#!/usr/bin/env bash
# Pulls the latest main, rebuilds and restarts the container. Normally run
# automatically by update-watcher.sh (via the telemax-updater systemd timer,
# see setup.sh) after the bot's /version "Обновить" button — safe to run by
# hand too if you'd rather update on your own schedule.
set -euo pipefail
cd "$(dirname "$0")"

echo "[update] $(date -u +%Y-%m-%dT%H:%M:%SZ) pulling latest main..."
git pull --ff-only

# Written before the rebuild/restart so the NEW container's own startup can
# read it and report back in Telegram (app.ts's reportIfJustUpdated) — just
# needs to exist by the time the new process boots.
mkdir -p .data
git rev-parse HEAD > .data/update-completed

echo "[update] building (GIT_COMMIT=$(git rev-parse --short HEAD))..."
GIT_COMMIT=$(git rev-parse HEAD) docker compose build

echo "[update] restarting..."
docker compose up -d

echo "[update] done."
