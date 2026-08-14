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

# Every rebuild retags `latest` onto the new image, leaving the previous one
# (the biggest chunk of disk churn per update — this image is ~2GB, mostly
# Chromium for sticker rendering) dangling. `image prune -f` only removes
# dangling/untagged images, never anything still referenced or cached for the
# next build — NOT `-a`/`system prune`, which strips the build cache too and
# makes every future rebuild slow again from scratch (hit that live 2026-08-14).
echo "[update] cleaning up dangling images..."
docker image prune -f >/dev/null 2>&1 || true

echo "[update] done."
