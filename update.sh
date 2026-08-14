#!/usr/bin/env bash
# Pulls the latest main, rebuilds and restarts the container. Normally run
# automatically by update-watcher.sh (via the telemax-updater systemd timer,
# see setup.sh) after the bot's /version "Обновить" button — safe to run by
# hand too if you'd rather update on your own schedule.
set -euo pipefail
cd "$(dirname "$0")"

# .env isn't loaded into this shell's own environment (docker's env_file: only
# injects it into the container) — read TELEGRAM_BOT_TOKEN/TARGET_TELEGRAM_GROUP
# ourselves so progress can be reported even while the bot itself is the thing
# being replaced.
set -a
# shellcheck disable=SC1091
[ -f .env ] && source .env
set +a

notify() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TARGET_TELEGRAM_GROUP:-}" ] || return 0
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TARGET_TELEGRAM_GROUP}" --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

STEP="старт"
on_error() {
  notify "❌ Обновление не удалось на шаге «${STEP}» — мост продолжает работать на прежней версии. Подробности: cat $(pwd)/data/update.log"
}
trap on_error ERR

notify "🔄 Начинаю обновление..."

STEP="git pull"
echo "[update] $(date -u +%Y-%m-%dT%H:%M:%SZ) pulling latest main..."
git pull --ff-only

# Written before the rebuild/restart so the NEW container's own startup can
# read it and report back in Telegram (app.ts's reportIfJustUpdated) — just
# needs to exist by the time the new process boots. `data/`, NOT `.data/` —
# that's the container-internal path; docker-compose.yml mounts host `./data`
# there, and these scripts run on the host, not in the container (mixed the
# two up originally, which silently broke the whole watcher — confirmed live
# 2026-08-14: a marker written straight to `data/` was never picked up
# because update-watcher.sh was checking `.data/` instead).
mkdir -p data
git rev-parse HEAD > data/update-completed

STEP="сборка образа"
echo "[update] building (GIT_COMMIT=$(git rev-parse --short HEAD))..."
GIT_COMMIT=$(git rev-parse HEAD) docker compose build

STEP="перезапуск контейнера"
echo "[update] restarting..."
docker compose up -d

STEP="проверка после запуска"
sleep 5
if [ -z "$(docker compose ps --status running --format '{{.Name}}' 2>/dev/null)" ]; then
  rm -f data/update-completed
  notify "❌ Контейнер не поднялся после обновления — проверьте: docker compose logs"
  exit 1
fi

# Every rebuild retags `latest` onto the new image, leaving the previous one
# (the biggest chunk of disk churn per update — this image is ~2GB, mostly
# Chromium for sticker rendering) dangling. `image prune -f` only removes
# dangling/untagged images, never anything still referenced or cached for the
# next build — NOT `-a`/`system prune`, which strips the build cache too and
# makes every future rebuild slow again from scratch (hit that live 2026-08-14).
echo "[update] cleaning up dangling images..."
docker image prune -f >/dev/null 2>&1 || true

echo "[update] done."
