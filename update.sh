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
# Set to 1 once the working tree has moved (right after the merge) and back to 0 once the new
# version has passed the liveness check. While it is 1, ANY unexpected failure must roll back —
# not only the build / up -d / liveness steps that handle their own: an error in between (writing
# data/update-completed or COMPOSE_PROJECT_NAME on a full disk, `docker compose ps` under pipefail)
# used to leave the tree on the new commit with the old container still running, and nothing
# retried until the next «Обновить».
ROLLBACK_ON_ERROR=0
on_error() {
  # update-completed is what the NEW container reports as "✅ Обновлено" on boot. If we die after
  # writing it (build ok, restart failed) it must not survive, or the bot cheerfully announces a
  # version that never started.
  rm -f data/update-completed
  if [ "$ROLLBACK_ON_ERROR" = "1" ]; then
    ROLLBACK_ON_ERROR=0
    # A failed rollback has already sent its own «откат не удался» warning — nothing may follow it
    # claiming the old version is back (review 2026-09-26, shell-r1#2).
    if rollback; then
      notify "❌ Обновление не удалось на шаге «${STEP}» — вернул прежнюю версию. Подробности на сервере: cat $(pwd)/data/update.log"
    fi
    return 0
  fi
  # Before the merge (fetch/verify) the tree hasn't moved, so there is nothing to roll back — and
  # don't promise anything about the running bridge beyond what we know.
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
# git reads SSH signatures only since 2.34 (Debian 11, Ubuntu 20.04 ship older): every tag failed
# verification and the refusal below blamed the source (review 2026-09-27, shell-r3.1#5).
GIT_V=$(git --version | awk '{print $3}')
if ! printf '2.34\n%s\n' "$GIT_V" | sort -C -V; then
  STEP="проверка подписи релиза"
  notify "❌ Обновление невозможно: git ${GIT_V} не умеет проверять подписи релизов (нужен 2.34+). Установите git новее (на Debian 11 — из bullseye-backports) или обновите ОС до Ubuntu 22.04+ / Debian 12+. Рабочая версия НЕ тронута."
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
  # Пробуем КАЖДЫЙ тег на коммите, а не только старший по версии: одна лишняя метка рядом с
  # настоящим релизом (например оставленная вручную) выигрывала сортировку, не проходила проверку
  # подписи — и обновления вставали навсегда, хотя валидный подписанный тег был тут же.
  # Только финальные релизы (vX.Y.Z): предрелиз вроде v1.1.0-beta.1 для стабильной установки не тег.
  local t seen=0
  tag=""
  for t in $(git tag --points-at "$CANDIDATE" 2>/dev/null | grep -E '^v[0-9]+(\.[0-9]+)*$' | sort -rV); do
    seen=1
    if git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS" verify-tag "$t" >/dev/null 2>&1; then
      tag="$t"
      break
    fi
    echo "[update] ${label}: подпись тега ${t} НЕ прошла проверку — пробую следующий"
  done
  if [ -z "$tag" ]; then
    if [ "$seen" = "1" ]; then
      echo "[update] ${label}: ни один тег на входящей версии не подписан корректно"
    else
      echo "[update] ${label}: на входящей версии нет тега релиза"
    fi
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
  # PREV_HEAD is the NEW commit here: a rollback to it rebuilt the very version that had just failed
  # and reported «вернул прежнюю». Roll back to what actually runs (review 2026-09-27, shell-r3.1#0).
  if [ -n "$DEPLOYED" ] && git cat-file -e "${DEPLOYED}^{commit}" 2>/dev/null; then PREV_HEAD="$DEPLOYED"; fi
fi

# Free megabytes where Docker keeps images and build cache (the smaller of its data root and, under
# the containerd image store, /var/lib/containerd). Empty when it cannot be measured.
free_mb() {
  local dir mb min=""
  for dir in "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)" /var/lib/containerd; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    mb=$(df -Pm "$dir" 2>/dev/null | awk 'NR==2 {print $4}') || mb=""
    case "$mb" in ''|*[!0-9]*) continue ;; esac
    if [ -z "$min" ] || [ "$mb" -lt "$min" ]; then min=$mb; fi
  done
  printf '%s' "$min"
}

# A build that runs out of disk fails at the very end, after minutes of work, with a message only
# the server log explains (reported 2026-10-03). Check BEFORE the tree moves. A release that changes
# the Dockerfile rebuilds the chromium+ffmpeg layer and needs far more room; the cache of the old
# one is useless then, so it is the first thing to go.
STEP="проверка свободного места"
NEED_MB="${UPDATE_MIN_FREE_MB:-1500}"
HEAVY_REBUILD=0
if ! git diff --quiet "$PREV_HEAD" "$CANDIDATE" -- Dockerfile 2>/dev/null; then
  HEAVY_REBUILD=1
  NEED_MB="${UPDATE_MIN_FREE_MB:-3000}"
fi
FREE_MB=$(free_mb)
if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt "$NEED_MB" ]; then
  echo "[update] свободно ${FREE_MB} МБ, нужно ${NEED_MB} МБ — убираю остатки прошлых сборок..."
  docker image prune -f >/dev/null 2>&1 || true
  [ "$HEAVY_REBUILD" = "1" ] && { docker builder prune -af >/dev/null 2>&1 || true; }
  FREE_MB=$(free_mb)
fi
if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt "$NEED_MB" ]; then
  echo "[update] мало места: свободно ${FREE_MB} МБ, нужно ${NEED_MB} МБ"
  notify "❌ Обновление отложено: на диске свободно ${FREE_MB} МБ, для сборки нужно не меньше ${NEED_MB} МБ. Освободите место на сервере (docker builder prune -af удалит кэш прошлых сборок) и нажмите «Обновить» ещё раз. Рабочая версия НЕ тронута."
  exit 1
fi
echo "[update] свободно на диске: ${FREE_MB:-?} МБ"

# Only now is the working tree allowed to move.
STEP="применение обновления"
# Refused up front: a merge that touches none of the edited files succeeds (and on the rebuild path
# it is a no-op), and a failed build/start then wiped the edits with rollback's reset --hard
# (review 2026-09-27, shell-r3.3#1). fileMode off: a lost exec bit is no edit.
if ! git -c core.fileMode=false diff --quiet HEAD --; then
  notify "❌ Обновление отклонено: в исходниках есть локальные правки (git status покажет, какие). Рабочая версия НЕ тронута."
  exit 1
fi
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
# Returns non-zero when the previous version could not be brought back up (it has then already sent
# the «откат не удался» warning) — callers send their «вернул прежнюю версию» only on success, and
# always call it as an `if` condition, so a failed rollback doesn't re-enter the ERR trap.
rollback() {
  if [ "$PREV_HEAD" = "$CANDIDATE" ]; then
    echo "[update] откатываться не на что: прежняя версия неизвестна"
    notify "⚠️ Откатиться не на что: неизвестно, какая версия работала до обновления, — мост может быть остановлен. Проверьте на сервере: cd $(pwd) && docker compose logs"
    return 1
  fi
  git merge --abort >/dev/null 2>&1 || true
  git reset --hard "$PREV_HEAD" >/dev/null 2>&1 || true
  rm -f data/update-completed
  local rc=0
  GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d --build >/dev/null 2>&1 || rc=$?
  # A running commit off the release line (deployed by hand from another branch) is rebuilt, but the
  # tree goes back to the release it was on: left on that commit, every later update was refused as a
  # diverged history (review 2026-09-27, shell-r3.2#1). The next run then retries the rebuild.
  git merge-base --is-ancestor "$PREV_HEAD" "$CANDIDATE" 2>/dev/null || git reset --hard "$CANDIDATE" >/dev/null 2>&1 || true
  if [ "$rc" -eq 0 ]; then
    echo "[update] откат выполнен: вернул прежнюю версию и поднял контейнер"
    # What the failed attempt left behind — otherwise every failure eats more of the disk.
    docker image prune -f >/dev/null 2>&1 || true
    return 0
  fi
  echo "[update] ОТКАТ НЕ УДАЛСЯ — мост может быть остановлен"
  notify "⚠️ Откат на прежнюю версию не удался — мост может быть остановлен. Нужен ручной запуск на сервере: cd $(pwd) && docker compose up -d --build"
  return 1
}
# From here until the liveness check passes, the ERR trap rolls back too (see on_error).
ROLLBACK_ON_ERROR=1

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
# The build output is kept so the failure notice can say WHY: «cat update.log» is beyond most users.
BUILD_LOG=$(mktemp)
if ! GIT_COMMIT=$(git rev-parse HEAD) docker compose build 2>&1 | tee "$BUILD_LOG"; then
  ROLLBACK_ON_ERROR=0
  if grep -qi 'no space left on device' "$BUILD_LOG"; then
    WHY="на диске кончилось место (свободно $(free_mb) МБ). Освободите его: docker builder prune -af — и нажмите «Обновить» ещё раз"
  else
    WHY=$(grep -E 'ERROR|failed to solve' "$BUILD_LOG" | tail -1 | cut -c1-300) || WHY=""
    [ -n "$WHY" ] || WHY="причина в логе"
  fi
  rm -f "$BUILD_LOG"
  if rollback; then
    notify "❌ Обновление не удалось на шаге «${STEP}»: ${WHY}. Вернул прежнюю версию, мост продолжает работать. Полный лог: cat $(pwd)/data/update.log"
  fi
  exit 1
fi
rm -f "$BUILD_LOG"

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
  ROLLBACK_ON_ERROR=0
  rm -f data/update-completed
  if rollback; then
    notify "❌ Не удалось запустить контейнер новой версии — вернул прежнюю. Проверьте: docker compose logs"
  fi
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
  ROLLBACK_ON_ERROR=0
  rm -f data/update-completed
  if rollback; then
    notify "❌ Контейнер не поднялся (или перезапускается по кругу) после обновления — вернул прежнюю версию исходников. Проверьте: docker compose logs"
  fi
  exit 1
fi
# The new version is up and verified — nothing after this point may roll it back.
ROLLBACK_ON_ERROR=0

# Every rebuild retags `latest` onto the new image, leaving the previous one
# (the biggest chunk of disk churn per update — this image is ~2GB, mostly
# Chromium for sticker rendering) dangling. `image prune -f` only removes
# dangling/untagged images, never anything still referenced or cached for the
# next build — NOT `-a`/`system prune`, which strips the build cache too and
# makes every future rebuild slow again from scratch (hit that live 2026-08-14).
# Deliberately AFTER the liveness window: until then the old image is the only way back.
echo "[update] cleaning up dangling images..."
docker image prune -f >/dev/null 2>&1 || true
# Build cache this build did not touch — layers of earlier releases — only ever grew (3.5 GB on the
# test server, 2026-10-04). Everything the build above used counts as recent and stays, the
# chromium layer included, so the next rebuild is still fast.
docker builder prune -f --filter until=1h >/dev/null 2>&1 || true

echo "[update] done."
