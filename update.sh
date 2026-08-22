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

# Installs set up before setup.sh started restricting .env permissions left it
# world-readable — tighten it on every update so old installs get fixed too.
[ -f .env ] && chmod 600 .env

# In-progress flag the container can see (data/ is mounted at /app/.data): the bot's
# "Обновить" button reads it to refuse a second request while one is already running.
# Cleared on ANY exit (success, failure, or crash) so it never gets stuck.
mkdir -p data
touch data/update-in-progress
trap 'rm -f data/update-in-progress' EXIT

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
# Self-hosted read-only mirror to fall back to when GitHub is unreachable (account flagged, or
# GitHub filtered on this network). Overridable via env so the mirror can move without a code
# change. Must serve the same `main` + tags as origin — the release script pushes to both.
MIRROR_GIT_URL="${MIRROR_GIT_URL:-http://zergont-gate.duckdns.org:3200/Telemax.git}"
echo "[update] $(date -u +%Y-%m-%dT%H:%M:%SZ) pulling latest main from origin (GitHub)..."
if git pull --ff-only; then
  echo "[update] pulled from origin (GitHub)"
else
  echo "[update] origin unreachable — falling back to mirror: ${MIRROR_GIT_URL}"
  git fetch "$MIRROR_GIT_URL" main
  git merge --ff-only FETCH_HEAD
  git fetch "$MIRROR_GIT_URL" "+refs/tags/*:refs/tags/*" || true
  echo "[update] updated from mirror"
fi

# Written before the rebuild/restart so the NEW container's own startup can
# read it and report back in Telegram (app.ts's reportIfJustUpdated) — just
# needs to exist by the time the new process boots. `data/`, NOT `.data/` —
# that's the container-internal path; docker-compose.yml mounts host `./data`
# there, and these scripts run on the host, not in the container (mixed the
# two up originally, which silently broke the whole watcher — confirmed live
# 2026-08-14: a marker written straight to `data/` was never picked up
# because update-watcher.sh was checking `.data/` instead).
STEP="проверка подписи релиза"
# Signed-release trust (v0.4): the transport (GitHub OR the self-hosted mirror) is untrusted — only
# the maintainer's GPG signature on the release tag is. When release-signing-key.asc is pinned in the
# repo, REQUIRE a valid signed tag at the pulled HEAD before building anything, so a compromised
# GitHub/mirror can't auto-deploy code. Absent (pre-signing installs, mid-transition) → skip.
PUBKEY_FILE="release-signing-key.asc"
if [ -f "$PUBKEY_FILE" ]; then
  if ! command -v gpg >/dev/null 2>&1; then
    notify "❌ Обновление отклонено: не установлен gpg для проверки подписи релиза (apt-get install -y gnupg)."
    exit 1
  fi
  VERIFY_HOME=$(mktemp -d)
  GNUPGHOME="$VERIFY_HOME" gpg --quiet --import "$PUBKEY_FILE" >/dev/null 2>&1 || true
  TAG_AT_HEAD=$(git tag --points-at HEAD 2>/dev/null | grep -E '^v[0-9]' | sort -V | tail -1 || true)
  if [ -z "$TAG_AT_HEAD" ]; then
    rm -rf "$VERIFY_HOME"
    notify "❌ Обновление отклонено: на новой версии нет подписанного тега."
    exit 1
  fi
  if ! GNUPGHOME="$VERIFY_HOME" git -c gpg.program=gpg verify-tag "$TAG_AT_HEAD" >/dev/null 2>&1; then
    rm -rf "$VERIFY_HOME"
    notify "❌ Обновление отклонено: подпись релиза ${TAG_AT_HEAD} не прошла проверку. Возможна компрометация источника — версия НЕ установлена."
    exit 1
  fi
  rm -rf "$VERIFY_HOME"
  echo "[update] release signature OK: ${TAG_AT_HEAD}"
else
  echo "[update] no release-signing-key.asc pinned — skipping signature check (bootstrap)."
fi

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
