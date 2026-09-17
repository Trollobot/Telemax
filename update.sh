#!/usr/bin/env bash
# Pulls the latest main, rebuilds and restarts the container. Normally run
# automatically by update-watcher.sh (via the telemax-updater systemd timer,
# see setup.sh) after the bot's /version "Обновить" button — safe to run by
# hand too if you'd rather update on your own schedule.
#
# ORDER MATTERS HERE (reworked in 0.6.4): fetch -> verify the signature on the INCOMING commit ->
# only then merge. The previous version pulled first and verified afterwards, which meant the
# untrusted transport (GitHub or the mirror) had already written update.sh / update-watcher.sh /
# setup.sh to disk — host scripts the systemd timer runs as root — before the check could refuse.
# The refusal message even claimed "версия НЕ установлена" while the working tree was already moved.
# Verifying before the merge also means allowed_signers is read from the CURRENT, already-trusted
# tree instead of the one being validated.
set -euo pipefail
cd "$(dirname "$0")"

# .env isn't loaded into this shell's own environment (docker's env_file: only injects it into the
# container) — read the few keys we need ourselves so progress can be reported even while the bot
# itself is the thing being replaced.
#
# NOT `source .env`: a value containing `$`, a space or a backtick (a proxy password, say) makes the
# shell treat it as code — under `set -u` that aborts update.sh on line 1, before any trap is armed,
# so updates die permanently and in total silence. Parse the keys instead, tolerating both the new
# quoted form written by setup.sh and the legacy bare form left by older installs.
env_get() {
  local line
  line=$(grep -m1 "^$1=" .env 2>/dev/null) || return 0
  line=${line#*=}
  case "$line" in
    "'"*"'") line=${line#\'}; line=${line%\'}; line=$(printf '%s' "$line" | sed "s/'\\\\''/'/g") ;;
    '"'*'"') line=${line#\"}; line=${line%\"} ;;
  esac
  printf '%s' "$line"
}
if [ -f .env ]; then
  TELEGRAM_BOT_TOKEN=$(env_get TELEGRAM_BOT_TOKEN)
  TARGET_TELEGRAM_GROUP=$(env_get TARGET_TELEGRAM_GROUP)
  TELEGRAM_PROXY=$(env_get TELEGRAM_PROXY)
else
  TELEGRAM_BOT_TOKEN=""; TARGET_TELEGRAM_GROUP=""; TELEGRAM_PROXY=""
fi

# Installs set up before setup.sh started restricting .env permissions left it
# world-readable — tighten it on every update so old installs get fixed too.
[ -f .env ] && chmod 600 .env

# In-progress flag the container can see (data/ is mounted at /app/.data): the bot's
# "Обновить" button reads it to refuse a second request while one is already running.
# Cleared on ANY exit (success, failure, or crash) so it never gets stuck — but a SIGKILL,
# an OOM or a reboot mid-run skips the trap entirely, which used to wedge the button FOREVER
# ("Обновление уже запущено", no message ever coming). The timestamp inside is what the bot
# now uses to treat an abandoned marker as stale (see UPDATE_MARKER_STALE_MS in bridge/sync.ts).
mkdir -p data
date -u +%Y-%m-%dT%H:%M:%SZ > data/update-in-progress
trap 'rm -f data/update-in-progress' EXIT

# Telegram notifications must honour TELEGRAM_PROXY: on a host that only reaches Telegram through a
# proxy — exactly the setup TELEGRAM_PROXY exists for — a bare curl silently fails and `|| true`
# swallows it, so the whole update runs in total silence, including a refusal for a bad signature.
# The token and the message go through `curl --config -` (stdin) rather than argv, so they don't
# show up in `ps` for every local user.
notify() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TARGET_TELEGRAM_GROUP:-}" ] || return 0
  local text esc_text esc_url esc_proxy
  text="$1"
  # curl's config format takes double-quoted values with backslash escapes.
  esc_text=$(printf '%s' "$text" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  esc_url=$(printf '%s' "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  esc_proxy=$(printf '%s' "${TELEGRAM_PROXY:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  {
    printf 'silent\n'
    printf 'url = "%s"\n' "$esc_url"
    printf 'data = "chat_id=%s"\n' "$TARGET_TELEGRAM_GROUP"
    printf 'data-urlencode = "text=%s"\n' "$esc_text"
    [ -n "${TELEGRAM_PROXY:-}" ] && printf 'proxy = "%s"\n' "$esc_proxy"
    printf 'output = "/dev/null"\n'
  } | curl --config - >/dev/null 2>&1 || true
  return 0
}

STEP="старт"
on_error() {
  # update-completed is what the NEW container reports as "✅ Обновлено" on boot. If we die after
  # writing it (build ok, restart failed) it must not survive, or the bot cheerfully announces a
  # version that never started.
  rm -f data/update-completed
  # Reached only on steps that do their own rollback-free exit (fetch/verify happen before the tree
  # moves), so don't promise anything about the running bridge beyond what we know.
  notify "❌ Обновление не удалось на шаге «${STEP}». Подробности на сервере: cat $(pwd)/data/update.log"
}
trap on_error ERR

notify "🔄 Начинаю обновление..."

# Self-hosted read-only mirror to fall back to when GitHub is unreachable (account flagged, or
# GitHub filtered on this network). Overridable via env so the mirror can move without a code
# change. Must serve the same `main` + tags as origin — the release script pushes to both.
MIRROR_GIT_URL="${MIRROR_GIT_URL:-https://zergont-gate.duckdns.org/Telemax.git}"
ALLOWED_SIGNERS="allowed_signers"
PREV_HEAD=$(git rev-parse HEAD)

# The trust anchor is non-negotiable: without it we cannot tell a real release from whatever the
# transport handed us. Every version since v0.4.1 ships allowed_signers, and this script always runs
# from the CURRENT (already trusted) checkout — so a missing file means a damaged or tampered
# install, not a legitimate bootstrap. The old "absent -> skip the check" branch made the whole
# signature scheme opt-out by deleting one file.
if [ ! -f "$ALLOWED_SIGNERS" ]; then
  STEP="проверка подписи релиза"
  notify "❌ Обновление отклонено: в установке нет файла allowed_signers (ключ для проверки подписи релизов). Переустановите мост — возможна повреждённая или подменённая копия."
  exit 1
fi
if ! command -v ssh-keygen >/dev/null 2>&1; then
  STEP="проверка подписи релиза"
  notify "❌ Обновление отклонено: нет ssh-keygen для проверки подписи (apt-get install -y openssh-client)."
  exit 1
fi

# Fetches main + tags from $1 into FETCH_HEAD WITHOUT touching the working tree, then reports the
# newest signed release tag sitting on the fetched commit (empty if there is none / it doesn't verify).
CANDIDATE=""
SIGNED_TAG=""
try_source() {
  local url="$1" label="$2" tag
  echo "[update] $(date -u +%Y-%m-%dT%H:%M:%SZ) fetching main from ${label}..."
  if ! git fetch "$url" main >/dev/null 2>&1; then
    echo "[update] ${label}: недоступен"
    return 1
  fi
  CANDIDATE=$(git rev-parse FETCH_HEAD)
  # Tags must arrive BEFORE the check — otherwise a perfectly signed release looks unsigned. A
  # failure here isn't fatal on its own: the verification below is what decides.
  git fetch "$url" "+refs/tags/*:refs/tags/*" >/dev/null 2>&1 || echo "[update] ${label}: теги не скачались"
  tag=$(git tag --points-at "$CANDIDATE" 2>/dev/null | grep -E '^v[0-9]' | sort -V | tail -1 || true)
  if [ -z "$tag" ]; then
    echo "[update] ${label}: на входящей версии нет тега релиза"
    return 1
  fi
  if ! git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS" verify-tag "$tag" >/dev/null 2>&1; then
    echo "[update] ${label}: подпись тега ${tag} НЕ прошла проверку"
    return 1
  fi
  # A reachable but STALE source must not beat a fresh one. `git merge --ff-only <ancestor>` prints
  # "Already up to date" and exits 0, so an origin frozen at an older release would silently produce a
  # "successful update" to a version OLDER than the one installed, and the mirror holding the real
  # release would never be tried. (Not hypothetical here: GitHub is frozen while the mirror carries
  # the current releases.) Require the candidate to contain what we already have.
  if ! git merge-base --is-ancestor "$PREV_HEAD" "$CANDIDATE" 2>/dev/null; then
    echo "[update] ${label}: там версия старее установленной или история разошлась — не подходит"
    return 1
  fi
  SIGNED_TAG="$tag"
  echo "[update] ${label}: подпись релиза OK (ssh): ${tag}"
  return 0
}

# The fallback used to hinge on `git pull` exit code alone, so a REACHABLE origin that simply had no
# signed tag at HEAD wedged updates forever — the mirror, which did have the release, was never even
# tried. Fall back on the RESULT (no verified release here), not merely on a network error.
STEP="получение обновления"
if ! try_source origin "GitHub"; then
  echo "[update] пробую резервное зеркало: ${MIRROR_GIT_URL}"
  if ! try_source "$MIRROR_GIT_URL" "зеркало"; then
    STEP="проверка подписи релиза"
    notify "❌ Обновление отклонено: ни на GitHub, ни на зеркале нет корректно подписанного релиза. Рабочая версия НЕ тронута."
    exit 1
  fi
fi

# What commit is ACTUALLY running? The bridge bakes GIT_COMMIT into its image, so this is the only
# honest answer — the git tree alone isn't one.
deployed_commit() {
  local cid out
  cid=$(docker compose ps -q 2>/dev/null | head -1) || cid=""
  [ -n "$cid" ] || return 0
  out=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" 2>/dev/null) || out=""
  printf '%s' "$out" | sed -n 's/^GIT_COMMIT=//p' | head -1 || true
  return 0
}

# Comparing the git tree alone would be a trap: an interrupt anywhere between the merge and a
# successful restart (kill -9, OOM, reboot, a failed `up -d`) leaves the tree on the NEW commit while
# the container still runs the OLD image — or nothing runs at all. Every later run would then say
# "уже на последней версии" and do nothing, and re-running update.sh by hand — the documented way out
# — would be a guaranteed no-op. Only skip the work when the running container really is this commit.
if [ "$CANDIDATE" = "$PREV_HEAD" ]; then
  DEPLOYED=$(deployed_commit)
  if [ -n "$DEPLOYED" ] && [ "$DEPLOYED" = "$PREV_HEAD" ]; then
    echo "[update] уже на последней версии (${SIGNED_TAG}) — обновлять нечего."
    notify "ℹ️ Обновление не требуется: уже установлена последняя версия (${SIGNED_TAG})."
    exit 0
  fi
  echo "[update] исходники уже на ${SIGNED_TAG}, но запущено не это — пересобираю и перезапускаю."
  notify "🔧 Исходники уже на последней версии, но работает не она — пересобираю."
fi

# Only now is the working tree allowed to move.
STEP="применение обновления"
if ! git merge --ff-only "$CANDIDATE" >/dev/null 2>&1; then
  notify "❌ Обновление отклонено: локальные изменения мешают обновиться (нужен fast-forward). Рабочая версия НЕ тронута."
  exit 1
fi
echo "[update] обновлено до ${SIGNED_TAG} ($(git rev-parse --short HEAD))"

# Anything that fails from here on has already moved the tree — put it back, so "мост продолжает
# работать на прежней версии" stays true and the next attempt starts from a known state.
# Restoring the SOURCES alone left the broken new container running (compose restarts it forever with
# `unless-stopped`) or nothing running at all — the bridge down, no bot left to press «Обновить» with,
# and the watcher only ever reacts to a marker the bot writes. That is a dead end no later release can
# reach. Bring the previous version back UP too; rebuilding it is cheap now that GIT_COMMIT is the
# last Dockerfile layer (measured: 1.6s).
rollback() {
  git merge --abort >/dev/null 2>&1 || true
  git reset --hard "$PREV_HEAD" >/dev/null 2>&1 || true
  rm -f data/update-completed
  if GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d --build >/dev/null 2>&1; then
    echo "[update] откат выполнен: вернул прежнюю версию и поднял контейнер"
  else
    echo "[update] ОТКАТ НЕ УДАЛСЯ — мост может быть остановлен"
    notify "⚠️ Откат на прежнюю версию не удался — мост может быть остановлен. Нужен ручной запуск на сервере: cd $(pwd) && docker compose up -d --build"
  fi
}

# Pin the compose project name explicitly (0.6.4). It used to be re-derived from the directory
# basename on every single command, so renaming the directory orphaned the running container, and
# two bridges in same-named directories silently shared one container, image and network. The value
# written here is the one Compose already computed for this install, so nothing about THIS install
# changes — the name just stops being implicit. (No `name:` key is added to docker-compose.yml on
# purpose: a default there would have re-pointed installs living in differently-named directories.)
compose_name_from_dir() {
  local n
  n=$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')
  [ -n "$n" ] || n=telemax
  printf '%s' "$n"
}
if [ -f .env ] && ! grep -q '^COMPOSE_PROJECT_NAME=' .env; then
  printf "COMPOSE_PROJECT_NAME='%s'\n" "$(compose_name_from_dir)" >> .env
  echo "[update] зафиксировал имя проекта Docker: $(compose_name_from_dir)"
fi

STEP="сборка образа"
echo "[update] building (GIT_COMMIT=$(git rev-parse --short HEAD))..."
if ! GIT_COMMIT=$(git rev-parse HEAD) docker compose build; then
  rollback
  notify "❌ Обновление не удалось на шаге «${STEP}» — вернул прежнюю версию, мост продолжает работать. Подробности: cat $(pwd)/data/update.log"
  exit 1
fi

# Written between a SUCCESSFUL build and the restart: the new container reads it on boot
# (app.ts's reportIfJustUpdated) and reports "✅ Обновлено". Writing it before the build — as this
# did until 0.6.4 — meant a failed build still left the marker behind, and the next boot of the OLD
# image announced a version that had never been installed. `data/`, NOT `.data/` — that's the
# container-internal path; docker-compose.yml mounts host `./data` there, and these scripts run on
# the host (mixing the two up silently broke the whole watcher once, confirmed live 2026-08-14).
mkdir -p data
git rev-parse HEAD > data/update-completed

STEP="перезапуск контейнера"
echo "[update] restarting..."
# The container runs as the unprivileged node user (uid 1000) — ./data must be
# writable by it; older installs created it root-owned, fix on every update.
chown -R 1000:1000 data 2>/dev/null || true
# The one post-merge step that had no rollback: `up -d` recreates the container, so a failure here
# (port taken, bad mount, no disk, a broken compose file in the new release) left the bridge fully
# down while the ERR trap cheerfully reported "мост продолжает работать на прежней версии".
if ! docker compose up -d; then
  rm -f data/update-completed
  rollback
  notify "❌ Не удалось запустить контейнер новой версии — вернул прежнюю. Проверьте: docker compose logs"
  exit 1
fi

# "Поднялся" used to mean `sleep 5` + "is something running?", which a container in a crash-restart
# loop passes just as happily as a healthy one (compose restarts it with `unless-stopped`). Watch it
# for half a minute instead and treat ANY restart as a failure.
STEP="проверка после запуска"
CONTAINER=$(docker compose ps --format '{{.Name}}' 2>/dev/null | head -1)
alive() {
  local i running restarts
  [ -n "$CONTAINER" ] || return 1
  for i in 1 2 3 4 5 6; do
    sleep 5
    running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)
    restarts=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo 1)
    [ "$running" = "true" ] || return 1
    [ "${restarts:-1}" = "0" ] || return 1
  done
  return 0
}
if ! alive; then
  rm -f data/update-completed
  rollback
  notify "❌ Контейнер не поднялся (или перезапускается по кругу) после обновления — вернул прежнюю версию исходников. Проверьте: docker compose logs"
  exit 1
fi

# Every rebuild retags `latest` onto the new image, leaving the previous one
# (the biggest chunk of disk churn per update — this image is ~2GB, mostly
# Chromium for sticker rendering) dangling. `image prune -f` only removes
# dangling/untagged images, never anything still referenced or cached for the
# next build — NOT `-a`/`system prune`, which strips the build cache too and
# makes every future rebuild slow again from scratch (hit that live 2026-08-14).
# Deliberately AFTER the liveness window: until then the old image is the only way back.
echo "[update] cleaning up dangling images..."
docker image prune -f >/dev/null 2>&1 || true

echo "[update] done."
