#!/usr/bin/env bash
# One-command bootstrap for a bare Ubuntu/Debian server: system update, git,
# Docker, clone the repo, hand off to setup.sh for the interactive key setup.
#
# Usage (as root, on a fresh server):
#   curl -fsSL https://raw.githubusercontent.com/Trollobot/Telemax/main/install.sh | bash
#
# Safe to re-run: skips steps that are already done (git/Docker already
# installed, repo already cloned — updates it to the latest SIGNED release instead).
set -euo pipefail

REPO_URL="https://github.com/Trollobot/Telemax.git"
# Read-only fallback mirror for when GitHub is unreachable (account flagged, or GitHub filtered on
# this network). Overridable via env so the mirror can move without editing this script.
MIRROR_GIT_URL="${MIRROR_GIT_URL:-https://zergont-gate.duckdns.org/Telemax.git}"
# Overridable so a SECOND, independent bridge can live on the same host (different bot, different
# group, different MAX account):  curl -fsSL <...>/install.sh | INSTALL_DIR=/opt/telemax-2 bash
# An EXPLICIT dir means the caller already decided what to do — the existing-bridges menu below
# stays out of the way (keeps the documented one-liner and any automation non-interactive).
if [ -n "${INSTALL_DIR:-}" ]; then INSTALL_DIR_EXPLICIT=1; else INSTALL_DIR_EXPLICIT=0; INSTALL_DIR=/opt/telemax; fi
# The maintainer's release-signing key, pinned HERE as well as in the repo's allowed_signers:
# update.sh trusts whatever allowed_signers the checkout carries, so a tampered clone (a
# compromised transport swapping in an attacker's key) would otherwise bootstrap a poisoned
# trust chain. It is the trust anchor for the CODE too: a fresh clone and an updated checkout are
# both moved only onto a release tag whose signature verifies against this key (see
# newest_signed_release), and the allowed_signers check further down only confirms the checkout
# carries the same key — comparing a public key file proves nothing about the code next to it. As
# long as THIS script arrived over HTTPS, a tampered source is refused.
EXPECTED_SIGNER='release@telemax namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILE1HMFVabDZUp6fRrnnt2lMgTY57ghrMP1pp+dE5MIe'

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root (на большинстве VPS вы и так root по SSH; иначе — sudo -i, затем повторите команду)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
# dpkg's conffile prompt ("cloud.cfg modified — Y/I/N/O/D/Z?") is NOT covered by DEBIAN_FRONTEND:
# that only silences debconf. With our stdin guard (</dev/null below) such a prompt hits EOF, the
# package is left half-configured, dpkg is broken for every later apt call — and get.docker.com,
# which runs its OWN apt-get, then fails too (hit live 2026-09-10 on a fresh Ubuntu 24.04 VPS whose
# provider had edited /etc/cloud/cloud.cfg). Fix: for the duration of this install, tell dpkg
# GLOBALLY to keep the existing config on a conflict (confold) and take the package default where
# there is none (confdef) — via apt.conf.d, so it also reaches apt-get calls we don't make
# ourselves (Docker's installer). Removed on exit, so the server's normal apt behaviour is untouched.
export UCF_FORCE_CONFOLD=1
APT_NI_SNIPPET=/etc/apt/apt.conf.d/99telemax-install
printf 'Dpkg::Options { "--force-confdef"; "--force-confold"; };\n' > "$APT_NI_SNIPPET"
# The pinned key in the form `git verify-tag` reads (gpg.ssh.allowedSignersFile).
SIGNERS=$(mktemp)
printf '%s\n' "$EXPECTED_SIGNER" > "$SIGNERS"
trap 'rm -f "$APT_NI_SNIPPET" "$SIGNERS"' EXIT
# Same two flags for direct dpkg calls (unquoted on purpose — it must split into two arguments).
DPKG_NI="--force-confdef --force-confold"

# Best-effort apt wrapper. Some VPS images ship with an unrelated package
# already broken (seen live — initramfs-tools' dhcpcd hook failing on a
# missing .so with nothing to do with Telemax) whose dpkg trigger re-fires
# and fails on EVERY subsequent apt-get call, not just the one that first
# surfaced it — upgrade, then installing jq, then (if left unguarded) the
# Docker install too. The package we actually asked for still installs fine
# each time; only that unrelated trigger's own exit code is non-zero.
# Aborting the whole bootstrap over someone else's package is worse than
# warning once and moving on, so every apt-get call in this script goes
# through this instead of a bare one.
# `</dev/null` on every apt/dpkg call is critical under `curl | bash`: bash reads THIS script from
# stdin (the pipe), and a package maintainer script that reads stdin during `apt upgrade` (grub,
# cloud-init, …) would otherwise consume the rest of the script and the install silently stops after
# that step (hit live on a fresh Ubuntu 24.04 box). Giving apt its own empty stdin keeps the pipe
# — and the rest of this script — intact for bash.
apt_get() {
  # A fresh VPS often still runs unattended-upgrades for minutes after boot, holding the apt/dpkg
  # locks — "Could not get lock" used to fail the very first step. Wait for it (bounded), and let
  # apt itself wait on the dpkg lock too.
  local waited=0
  while pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1 || pgrep -f unattended-upgrade >/dev/null 2>&1; do
    [ "$waited" -eq 0 ] && echo "  ⏳ Жду, пока система закончит фоновое обновление (unattended-upgrades)..."
    sleep 5; waited=$((waited + 5)); [ "$waited" -ge 600 ] && break
  done
  if ! apt-get -o DPkg::Lock::Timeout=300 "$@" </dev/null; then
    echo "⚠️  apt-get $* завершился с предупреждением (см. вывод выше) — похоже, дело в стороннем пакете, не связанном с Telemax. Продолжаю; если хотите разобраться отдельно, обычно помогает: dpkg --configure -a"
    # With the force flags, a pending configure that was waiting on a conffile prompt actually
    # completes here instead of dying on the same question (which is what used to happen).
    dpkg --configure -a $DPKG_NI >/dev/null 2>&1 </dev/null || true
  fi
}

# Release tags are verified with SSH signatures (git -c gpg.format=ssh verify-tag), which git only
# understands since 2.34. An older git (Debian 11: 2.30, Ubuntu 20.04: 2.25) failed every tag, and a
# fresh install stopped with «возможна подмена источника» — wrong, and no retry could ever help
# (review 2026-09-26, shell-r2#1). True when the installed git is new enough (same check as update.sh).
git_verifies_ssh_signatures() { printf '2.34\n%s\n' "$(git --version 2>/dev/null | awk '{print $3}')" | sort -C -V; }
# Prints why this host cannot verify a release signature at all (nokeygen | oldgit); nothing when it can.
verify_blocker() {
  command -v ssh-keygen >/dev/null 2>&1 || { echo nokeygen; return 0; }
  git_verifies_ssh_signatures || echo oldgit
}

# Why the checkout could not be moved to a release, with the fix: one reason per failed attempt
# (GitHub, then the mirror) accumulates in UPDATE_FAIL_REASONS; a fresh install that cannot verify
# a signature at all passes its blocker as $1. «Переустановка начисто» is NOT advice here: it keeps
# the git checkout (only .env and data are wiped), so the same update fails again with the same
# message — an endless loop (review 2026-09-26, shell-r2#0). What does help: removing the bridge
# (the menu backs it up first) and installing it anew, or moving the checkout onto a release by hand.
UPDATE_FAIL_REASONS=""
explain_update_failure() {
  local reinstall="Или удалите мост (install.sh без INSTALL_DIR → пункт 3 «Удалить мост»; настройки и данные сначала сохраняются в бэкап в /root) и установите его заново."
  case "${1:-$UPDATE_FAIL_REASONS}" in
    *oldgit*)
      echo "   $(git --version) не умеет проверять подписи релизов — нужен git 2.34+: на Debian 11 он есть в bullseye-backports,"
      echo "   иначе обновите ОС до Ubuntu 22.04+ / Debian 12+ — и запустите install.sh снова." ;;
    *localchanges*)
      echo "   В $INSTALL_DIR изменены файлы проекта — обновление только fast-forward, поверх правок не пойдёт."
      echo "   Посмотрите, что изменено: git -C $INSTALL_DIR status. Уберите правки (git -C $INSTALL_DIR stash) и запустите install.sh снова."
      echo "   $reinstall" ;;
    *stale*)
      echo "   История установки разошлась с опубликованным релизом. Вручную переведите исходники на последний релиз:"
      echo "   git -C $INSTALL_DIR fetch --tags $REPO_URL main, затем git -C $INSTALL_DIR reset --hard vX.Y.Z (последний тег) — и запустите install.sh снова."
      echo "   $reinstall" ;;
    *older*) echo "   Установлена версия новее, чем сейчас есть в доступном источнике, — обновлять нечего. Если ждёте новый релиз, повторите install.sh позже." ;;
    *nokeygen*) echo "   Нет ssh-keygen для проверки подписи: apt-get install -y openssh-client — и запустите install.sh снова." ;;
    *nosig*) echo "   Подписанного релиза, до которого можно обновиться, сейчас нет. Повторите install.sh позже, после выхода релиза." ;;
    *) echo "   Не удалось связаться ни с GitHub, ни с резервным зеркалом. Проверьте сеть сервера и запустите install.sh снова." ;;
  esac
}

# Preflight: name the reasons an install would fail BEFORE spending minutes on apt/Docker. Hard
# stops only for what can't work at all (arch, disk, a git too old to verify a release on a fresh
# install); everything else is a warning with the fix.
preflight() {
  local fail=0 free_mb mem_mb hp net_ts skew
  . /etc/os-release 2>/dev/null || true
  case "${ID:-}" in
    ubuntu | debian) echo "  ОС: ${PRETTY_NAME:-?} — OK" ;;
    *) echo "  ⚠️  ОС ${PRETTY_NAME:-неизвестна}: скрипт рассчитан на Ubuntu/Debian (apt). Продолжаю, но без гарантий." ;;
  esac
  case "$(uname -m)" in
    x86_64 | aarch64) echo "  Архитектура: $(uname -m) — OK" ;;
    *) echo "  ❌ Архитектура $(uname -m) не поддерживается (нужна x86_64 или arm64)."; fail=1 ;;
  esac
  # Checked again after step [2/6], when git was only just installed.
  if command -v git >/dev/null 2>&1 && ! git_verifies_ssh_signatures; then
    if [ -d "$INSTALL_DIR/.git" ]; then
      echo "  ⚠️  $(git --version) не умеет проверять подписи релизов (нужен 2.34+) — обновить мост не получится, только перенастроить."
    else
      echo "  ❌ Без проверки подписи релиза установка невозможна:"
      explain_update_failure oldgit
      fail=1
    fi
  fi
  free_mb=$(df -Pm / | awk 'NR==2{print $4}')
  if [ "${free_mb:-0}" -lt 3072 ]; then
    echo "  ❌ Свободно ${free_mb} МБ на / — нужно минимум 3 ГБ (образ ~1.7 ГБ + сборка)."; fail=1
  else
    echo "  Диск: свободно ${free_mb} МБ — OK"
  fi
  mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
  if [ "${mem_mb:-0}" -lt 900 ]; then
    echo "  ⚠️  RAM ${mem_mb} МБ — сборка образа с Chromium может не пройти; при установке выберите slim (лёгкий образ)."
  else
    echo "  RAM: ${mem_mb} МБ — OK"
  fi
  for hp in api.telegram.org:443 api2.oneme.ru:443 zergont-gate.duckdns.org:443; do
    if timeout 5 bash -c "cat </dev/null >/dev/tcp/${hp%%:*}/${hp##*:}" 2>/dev/null; then
      echo "  Сеть: ${hp%%:*} — OK"
    else
      echo "  ⚠️  Сеть: ${hp%%:*} недоступен (для Telegram может помочь прокси — setup.sh спросит; MAX и зеркало нужны напрямую)."
    fi
  done
  net_ts=$(curl -fsSI --max-time 8 https://api.telegram.org 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="date"{print $2}')
  if [ -n "$net_ts" ]; then
    skew=$(( $(date +%s) - $(date -d "$net_ts" +%s 2>/dev/null || date +%s) )); skew=${skew#-}
    if [ "$skew" -gt 300 ]; then
      echo "  ⚠️  Часы сервера расходятся с реальным временем на ${skew}с — TLS/Telegram могут отказывать. Обычно лечит: timedatectl set-ntp true"
    else
      echo "  Время: OK"
    fi
  fi
  [ "$fail" -eq 0 ]
}

bold "=== Telemax — установка ==="

# ---------------------------------------------------------------------------
# Existing bridges: find every configured install on this host and, when the
# run is interactive and the caller didn't pin INSTALL_DIR, offer a menu —
# update/reconfigure one, add another, or remove one/all. Sources: the 0.6.4
# auto-update registry, Docker compose labels (catches installs that predate
# the registry or fell out of it) and the default /opt/telemax* location.
# A "bridge" = a directory holding a Telemax checkout (docker-compose.yml +
# update-watcher.sh). One without .env — an interrupted install — is listed as
# «не настроен», so the menu can finish or remove it instead of losing it.
# ---------------------------------------------------------------------------
discover_installs() {
  {
    cat /etc/telemax/instances 2>/dev/null || true
    docker ps -a --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null || true
    ls -d /opt/telemax* 2>/dev/null || true
  } | sort -u | while IFS= read -r d; do
    if [ -n "$d" ] && [ -f "$d/docker-compose.yml" ] && [ -f "$d/update-watcher.sh" ]; then printf '%s\n' "$d"; fi
  done
}
install_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -1; }
install_status() {
  if [ ! -f "$1/.env" ]; then printf '⚙️ не настроен'; return 0; fi
  # Container names live under the compose project name — setup.sh writes it into .env
  # since 0.6.4; older installs derive it from the directory basename (same rule).
  local name
  name=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$1/.env" 2>/dev/null | head -1 | tr -d "\"'")
  [ -n "$name" ] || name=$(basename "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')
  if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$name" 2>/dev/null)" ]; then
    printf '🟢 работает'
  elif [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$name" 2>/dev/null)" ]; then
    printf '🔴 остановлен'
  else
    printf '⚪ контейнера нет'
  fi
}
# Saves the only irreplaceable parts (.env = tokens/keys, data/ = MAX session + chat map)
# before anything destructive. Prints the archive path, or nothing if there was nothing to save.
# Returns NON-ZERO when there WAS something to save and no archive came out — callers must then
# refuse to delete anything. (It used to fail silently: an `if` without `else` returns 0, so under
# `set -e` the caller went straight on to `rm -rf` after the menu had promised a backup.)
backup_install() {
  local dir="$1" slug base out items=() rc=0 n=0
  slug=$(basename "$dir" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')
  base="/root/telemax-backup-${slug:-telemax}-$(date +%Y%m%d-%H%M%S)"
  # Never over an existing archive: /opt/telemax and /root/Telemax share a slug, and two backups
  # in the same second replaced the first one after its install was deleted (review 2026-09-27, shell-r3.1#6).
  out="$base.tar.gz"
  while [ -e "$out" ]; do n=$((n + 1)); out="$base-$n.tar.gz"; done
  [ -f "$dir/.env" ] && items+=(.env)
  [ -d "$dir/data" ] && items+=(data)
  [ "${#items[@]}" -gt 0 ] || return 0
  # umask 077: the archive holds the bot token and MAX_SESSION_KEY — root-only, like .env itself
  # (root's default umask would have made it world-readable 0644). GNU tar exits 1 for "file
  # changed as we read it" (the running bridge writes to data/) — the archive is still written, so
  # only >= 2 (fatal) counts as a failure. tar's own stderr stays visible so the reason is on screen.
  ( umask 077; tar -czf "$out" -C "$dir" "${items[@]}" ) >&2 || rc=$?
  if [ "$rc" -le 1 ] && [ -s "$out" ]; then
    printf '%s' "$out"
    return 0
  fi
  rm -f "$out"
  return 1
}
delete_install() {
  local dir="$1" bak ids
  echo "Удаляю мост в $dir..."
  if ! bak=$(backup_install "$dir"); then
    echo "❌ Не удалось сохранить бэкап настроек и данных ($dir/.env, $dir/data) в /root — мост НЕ удаляю."
    echo "   Проверьте место на диске (df -h /root) и запустите install.sh снова."
    exit 1
  fi
  if [ -n "$bak" ]; then echo "  На всякий случай настройки и данные сохранены: $bak"; fi
  if command -v docker >/dev/null 2>&1; then
    # compose needs .env (env_file, COMPOSE_PROJECT_NAME): without it, it fails on older Compose or
    # falls back to the directory name — another bridge's project. Whatever still carries this
    # directory's label is removed either way, or it kept relaying with the old token.
    if [ -f "$dir/docker-compose.yml" ] && [ -f "$dir/.env" ]; then
      (cd "$dir" && docker compose down -v --rmi local --remove-orphans) </dev/null || true
    fi
    ids=$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$dir" 2>/dev/null || true)
    [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  fi
  rm -rf "$dir"
  if [ -f /etc/telemax/instances ]; then
    grep -vxF "$dir" /etc/telemax/instances > /etc/telemax/instances.tmp 2>/dev/null || true
    mv /etc/telemax/instances.tmp /etc/telemax/instances
  fi
  git config --system --fixed-value --unset-all safe.directory "$dir" 2>/dev/null || true
  echo "  Мост $dir удалён."
}
# The auto-update timer, dispatcher and registry are host-shared — remove them only when the
# LAST bridge is gone. Docker and Fail2ban stay: they belong to the server, not to Telemax.
maybe_remove_updater() {
  if [ -z "$(discover_installs)" ]; then
    systemctl disable --now telemax-updater.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/telemax-updater.timer /etc/systemd/system/telemax-updater.service /usr/local/sbin/telemax-updater
    # The shared big-file service (files-service/reconcile.sh) and its instant-start trigger.
    systemctl disable --now telemax-files.path >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/telemax-files.path /etc/systemd/system/telemax-files.service
    if [ -f /var/lib/telemax-files/compose.yml ]; then
      docker compose -p telemax-files -f /var/lib/telemax-files/compose.yml down >/dev/null 2>&1 || true
    fi
    rm -rf /var/lib/telemax-files
    rm -f /etc/telemax/instances
    rmdir /etc/telemax 2>/dev/null || true
    systemctl daemon-reload >/dev/null 2>&1 || true
    echo "Это был последний мост — общий таймер автообновления тоже убран (Docker и Fail2ban не тронуты: они серверные)."
  fi
}
# Prints the chosen directory from EXISTING, or nothing on a bad answer. With a single
# install there is nothing to ask.
pick_install() {
  local n="${#EXISTING[@]}" c=""
  if [ "$n" -eq 1 ]; then printf '%s' "${EXISTING[0]}"; return 0; fi
  read -rp "$1 [1-$n]: " c </dev/tty || true
  case "$c" in '' | *[!0-9]*) return 0 ;; esac
  if [ "$c" -ge 1 ] && [ "$c" -le "$n" ]; then printf '%s' "${EXISTING[$((c - 1))]}"; fi
}

CLEAN_REINSTALL=0
if [ "$INSTALL_DIR_EXPLICIT" -eq 0 ] && bash -c ': </dev/tty' 2>/dev/null; then
  mapfile -t EXISTING < <(discover_installs)
  if [ "${#EXISTING[@]}" -gt 0 ]; then
    echo "На этом сервере уже есть мост(ы) Telemax:"
    _i=1
    for _d in "${EXISTING[@]}"; do
      printf '  %d) %s — v%s, %s\n' "$_i" "$_d" "$(install_version "$_d")" "$(install_status "$_d")"
      _i=$((_i + 1))
    done
    echo
    echo "Что сделать?"
    echo "  1) Обновить или перенастроить существующий мост"
    echo "  2) Установить ещё один, НОВЫЙ мост (ему нужны свой бот, своя группа и свой номер MAX)"
    echo "  3) Удалить мост"
    echo "  0) Ничего, выйти"
    MENU_CHOICE=""
    read -rp "Выбор [1]: " MENU_CHOICE </dev/tty || true
    case "${MENU_CHOICE:-1}" in
      2)
        _i=2
        while [ -e "/opt/telemax-$_i" ]; do _i=$((_i + 1)); done
        NEW_DIR=""
        read -rp "Каталог для нового моста [/opt/telemax-$_i]: " NEW_DIR </dev/tty || true
        INSTALL_DIR="${NEW_DIR:-/opt/telemax-$_i}"
        ;;
      3)
        TARGET=""
        if [ "${#EXISTING[@]}" -gt 1 ]; then
          echo "Какой удалить? (0 — ВСЕ мосты)"
          DEL_CHOICE=""
          read -rp "Номер [ничего не удалять]: " DEL_CHOICE </dev/tty || true
          if [ "$DEL_CHOICE" = "0" ]; then TARGET="ALL"; else
            case "$DEL_CHOICE" in *[!0-9]* | '') TARGET="" ;; *)
              if [ "$DEL_CHOICE" -ge 1 ] && [ "$DEL_CHOICE" -le "${#EXISTING[@]}" ]; then TARGET="${EXISTING[$((DEL_CHOICE - 1))]}"; fi ;;
            esac
          fi
        else
          TARGET="${EXISTING[0]}"
        fi
        if [ -z "$TARGET" ]; then echo "Не понял выбор — ничего не удаляю."; exit 0; fi
        if [ "$TARGET" = "ALL" ]; then
          echo "⚠️  Будут удалены ВСЕ мосты: контейнеры, образы и каталоги со всеми данными."
        else
          echo "⚠️  Будет удалён мост $TARGET: контейнер, образ и каталог со всеми данными."
        fi
        CONFIRM=""
        read -rp "Точно? Введите «да»: " CONFIRM </dev/tty || true
        case "$CONFIRM" in да | Да | ДА) : ;; *) echo "Отменено — ничего не удалял."; exit 0 ;; esac
        if [ "$TARGET" = "ALL" ]; then
          for _d in "${EXISTING[@]}"; do delete_install "$_d"; done
        else
          delete_install "$TARGET"
        fi
        maybe_remove_updater
        echo "Готово."
        exit 0
        ;;
      0)
        echo "Выход — ничего не менял."
        exit 0
        ;;
      *)
        TARGET=$(pick_install "Какой мост обновить/перенастроить?")
        if [ -z "$TARGET" ]; then echo "Не понял выбор — выхожу, ничего не менял."; exit 0; fi
        INSTALL_DIR="$TARGET"
        echo "  1) Обновить (настройки сохраняются, откроется меню настроек)"
        echo "  2) Переустановить НАЧИСТО (настройки и данные сбросить; перед этим сохраню их в бэкап)"
        SUB_CHOICE=""
        read -rp "Выбор [1]: " SUB_CHOICE </dev/tty || true
        if [ "${SUB_CHOICE:-1}" = "2" ]; then CLEAN_REINSTALL=1; fi
        ;;
    esac
  fi
fi

echo "Каталог установки: $INSTALL_DIR"
if [ -f "$INSTALL_DIR/.env" ] && [ "$CLEAN_REINSTALL" -eq 0 ]; then
  echo
  echo "ℹ️  В $INSTALL_DIR уже есть НАСТРОЕННАЯ установка — обновлю её и открою меню настроек."
  echo "    Нужен ВТОРОЙ независимый мост на этом сервере? Укажите другой каталог:"
  echo "      curl -fsSL https://zergont-gate.duckdns.org/install.sh | INSTALL_DIR=/opt/telemax-2 bash"
  echo "    (у него должен быть свой бот, своя группа и свой номер MAX)"
fi
echo

# Everything below is also written to a log file — attach it to a bug report if something fails.
# Per-directory, so a second install doesn't interleave its output into the first one's log.
# After the menu on purpose: the log belongs to the directory the user actually chose.
INSTALL_SLUG=$(basename "$INSTALL_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')
INSTALL_LOG="/var/log/telemax-install-${INSTALL_SLUG:-telemax}.log"
exec > >(tee -a "$INSTALL_LOG") 2>&1
echo "(лог установки: $INSTALL_LOG)"

echo "[0/6] Проверяю сервер..."
preflight || { echo "❌ Сервер не подходит для установки — см. причины выше."; exit 1; }
echo
echo "[1/6] Обновляю систему (может занять несколько минут)..."
apt_get update -y
apt_get upgrade -y

echo
echo "[2/6] Проверяю git и jq..."
# jq: used by setup.sh to auto-detect the Telegram group id (no need to hunt for it
# manually — see setup.sh). The release-signature check (below when updating an existing
# checkout, and in update.sh) uses ssh-keygen from openssh-client — normally already present on
# any host you can SSH into; installed here only if it is missing.
for pkg in git jq; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    apt_get install -y "$pkg"
  fi
done
command -v ssh-keygen >/dev/null 2>&1 || apt_get install -y openssh-client
# A git installed just now is the distro's — on an older release too old to verify a signed release.
# A fresh install stops here; an existing checkout (warned in preflight) can still be reconfigured.
BLOCKER=$(verify_blocker)
if [ -n "$BLOCKER" ] && [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "❌ Без проверки подписи релиза установка невозможна:"
  explain_update_failure "$BLOCKER"
  exit 1
fi

echo
echo "[3/6] Проверяю Docker..."
if ! command -v docker >/dev/null 2>&1; then
  # get.docker.com's own script calls apt-get install internally and can hit
  # the exact same recurring trigger issue — don't trust its exit code alone,
  # check whether docker actually landed afterward.
  # Never hand Docker's installer a half-configured dpkg — its own apt-get would fail on it.
  dpkg --configure -a $DPKG_NI >/dev/null 2>&1 </dev/null || true
  curl -fsSL https://get.docker.com | sh || true
  if ! command -v docker >/dev/null 2>&1; then
    # get.docker.com unreachable/blocked or its repo setup failed — fall back to the distro packages
    # (docker.io + the compose v2 plugin): older, but plenty for this bridge.
    echo "Установщик Docker не сработал — пробую пакеты дистрибутива (docker.io)..."
    apt_get install -y docker.io
    apt_get install -y docker-compose-v2
    docker compose version >/dev/null 2>&1 || apt_get install -y docker-compose-plugin
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "❌ Docker всё ещё не установлен после двух попыток. Смотрите ошибки выше и лог $INSTALL_LOG, затем запустите install.sh заново."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "❌ Docker есть, но нет Docker Compose v2 (команда 'docker compose'). Установите плагин: apt-get install docker-compose-v2 (или docker-compose-plugin) — и запустите install.sh заново."
    exit 1
  fi
else
  echo "Docker уже установлен."
fi
systemctl enable --now docker >/dev/null 2>&1 || true

echo
echo "[4/6] Защита сервера от подбора пароля по SSH (Fail2ban)..."
# The bridge opens no inbound ports (MAX = outbound TCP, Telegram = long-polling), so the only
# door on this host is SSH — and every public server gets hammered with password guesses within
# hours of going online. Fail2ban's stock `sshd` jail bans a source after 5 failures in 10 min
# (for 10 min). Offered, not forced: default YES, 30s timeout so an unattended run isn't
# blocked. Read from /dev/tty — under `curl | bash` stdin is the script itself. The `if` keeps a
# timed-out read from tripping `set -e`.
#
# The jail reads the journal (`backend = systemd`) — chosen because minimal Ubuntu 22.04/24.04
# images ship no /var/log/auth.log, where fail2ban's default backend can't start the sshd jail at
# all. That backend needs the python3-systemd bindings, which Ubuntu/Debian do NOT pull in as a
# fail2ban dependency. 0.5.0 shipped without them: the service came up, the jail silently died
# ("No module named 'systemd'") and the script still reported success — caught live on the test
# box 2026-09-05. Hence: install both, and verify the JAIL (not the service) before claiming
# protection.
f2b_jail_up() {
  # The server needs a moment after start; a status query before "Server ready" fails spuriously.
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if fail2ban-client status sshd >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
f2b_report() {
  if f2b_jail_up; then
    echo "Fail2ban включён: jail sshd работает${F2B_SELF_IP:+, ваш IP ${F2B_SELF_IP} в белом списке}."
  else
    echo "⚠️  Fail2ban запущен, но jail sshd не поднялся — защиты SSH НЕТ. Причина из лога:"
    grep -E "ERROR" /var/log/fail2ban.log 2>/dev/null | tail -3 | sed 's/^/    /' || true
    echo "    Проверьте: fail2ban-client status sshd"
  fi
}
if command -v fail2ban-client >/dev/null 2>&1; then
  # Already installed. One targeted self-heal: a config on the systemd backend (ours from 0.5.0,
  # or the user's own) with the bindings missing = a jail that never started. Add the module and
  # restart; everything else about an existing setup is left alone.
  if grep -qs '^backend *= *systemd' /etc/fail2ban/jail.local 2>/dev/null \
     && ! python3 -c 'import systemd.journal' >/dev/null 2>&1; then
    echo "Fail2ban уже стоит, но без python3-systemd его jail sshd не работает — доставляю модуль..."
    apt_get install -y python3-systemd
    systemctl restart fail2ban >/dev/null 2>&1 </dev/null || true
    F2B_SELF_IP=""; f2b_report
  else
    echo "Fail2ban уже установлен — пропускаю."
  fi
else
  F2B_CHOICE=""
  if read -t 30 -rp "Поставить Fail2ban? [Y/n] (жду 30с, по умолчанию — да): " F2B_CHOICE </dev/tty; then :; else echo; fi
  case "${F2B_CHOICE:-}" in
    n | N | no | NO | нет | Нет) echo "Пропускаю Fail2ban." ;;
    *)
      apt_get install -y fail2ban python3-systemd
      # Whitelist the IP of this very SSH session so the installer can't lock THEMSELVES out by
      # mistyping their password (SSH_CONNECTION is exported by sshd; empty when not over SSH).
      # Only written on a fresh install (the command -v branch above never clobbers a user's own
      # jail.local).
      F2B_SELF_IP="${SSH_CONNECTION:-}"
      F2B_SELF_IP="${F2B_SELF_IP%% *}"
      cat > /etc/fail2ban/jail.local <<EOF
[DEFAULT]
backend = systemd
ignoreip = 127.0.0.1/8 ::1 ${F2B_SELF_IP}

[sshd]
enabled = true
EOF
      systemctl enable --now fail2ban >/dev/null 2>&1 </dev/null || true
      f2b_report
      ;;
  esac
fi

# A fresh clone and an existing checkout are moved only onto a release whose tag verifies against the
# PINNED key (a clone carries nothing trusted yet; a very old checkout carries no key at all). Prints
# the newest v* tag in the history of $2 (main's tip) whose signature verifies — a release on a side
# branch does not count, untagged work after the newest release is skipped. Only final releases
# (vX.Y.Z): `sort -rV` ranks v1.1.0-beta.1 above v1.1.0, so a pre-release tag would win a fresh
# install. Non-zero when there is none.
newest_signed_release() {
  local t
  for t in $(git -C "$1" tag -l 'v[0-9]*' 2>/dev/null | grep -E '^v[0-9]+(\.[0-9]+)*$' | sort -rV); do
    git -C "$1" merge-base --is-ancestor "$t" "$2" 2>/dev/null || continue
    if git -C "$1" -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$SIGNERS" verify-tag "$t" >/dev/null 2>&1; then
      printf '%s' "$t"
      return 0
    fi
  done
  return 1
}
# An EXISTING checkout follows update.sh's order: fetch -> verify the release in the INCOMING main ->
# only then fast-forward, so nothing unverified ever reaches the working tree. Not delegated to
# update.sh: the checkout's copy is the OLD release's, trusts the checkout's own allowed_signers and
# rebuilds/restarts/reports to Telegram — here setup.sh comes next and decides that. Fetches from $2
# into FETCH_HEAD without touching the tree and sets RELEASE to the verified tag; a failed attempt
# appends its reason to UPDATE_FAIL_REASONS. GIT_TERMINAL_PROMPT=0: a flagged GitHub fails fast.
RELEASE=""
fetch_release() {
  local dir="$1" url="$2" label="$3" tip t
  echo "  Получаю main (${label})..."
  if ! GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch "$url" main >/dev/null 2>&1; then
    echo "  ${label}: недоступен"
    UPDATE_FAIL_REASONS="$UPDATE_FAIL_REASONS network"
    return 1
  fi
  # main's tip is taken BEFORE the tag fetch, which overwrites FETCH_HEAD with the tags themselves.
  tip=$(git -C "$dir" rev-parse FETCH_HEAD)
  GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch "$url" "+refs/tags/*:refs/tags/*" >/dev/null 2>&1 || echo "  ${label}: теги не скачались"
  if ! t=$(newest_signed_release "$dir" "$tip"); then
    echo "  ${label}: в main нет корректно подписанного релиза"
    UPDATE_FAIL_REASONS="$UPDATE_FAIL_REASONS nosig"
    return 1
  fi
  # An install newer than the source (it lags behind, e.g. a frozen GitHub) needs nothing done;
  # only a diverged history does (review 2026-09-27, shell-r3.1#3).
  if ! git -C "$dir" merge-base --is-ancestor HEAD "$t" 2>/dev/null; then
    if git -C "$dir" merge-base --is-ancestor "$t" HEAD 2>/dev/null; then
      echo "  ${label}: там релиз ${t}, а установлен более новый — не подходит"
      UPDATE_FAIL_REASONS="$UPDATE_FAIL_REASONS older"
    else
      echo "  ${label}: история установки разошлась с релизом ${t} — не подходит"
      UPDATE_FAIL_REASONS="$UPDATE_FAIL_REASONS stale"
    fi
    return 1
  fi
  echo "  ${label}: подпись релиза OK (ssh): ${t}"
  RELEASE="$t"
}
# Returns non-zero (tree untouched) when no source offers a verified release or it can't be
# fast-forwarded to.
update_existing_checkout() {
  local dir="$1"
  if [ -n "$BLOCKER" ]; then
    echo "  Подпись релиза проверить нечем."
    UPDATE_FAIL_REASONS="$BLOCKER"
    return 1
  fi
  fetch_release "$dir" origin "GitHub" || fetch_release "$dir" "$MIRROR_GIT_URL" "зеркало" || return 1
  if ! git -C "$dir" merge --ff-only "$RELEASE^{commit}" >/dev/null 2>&1; then
    echo "  Локальные изменения мешают обновиться (нужен fast-forward)."
    UPDATE_FAIL_REASONS="$UPDATE_FAIL_REASONS localchanges"
    return 1
  fi
  echo "Исходники на релизе ${RELEASE} (подпись проверена)."
}

echo
echo "[5/6] Скачиваю проект в $INSTALL_DIR..."
CHECKOUT_UNCHANGED=0 # 1 when an existing checkout was left exactly as it was (no verified release)
FRESH_CLONE=0        # 1 when $INSTALL_DIR was cloned just now (nothing user-owned in it yet)
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Уже склонировано — обновляю до последнего подписанного релиза..."
  # A failure leaves the install on its current, already-trusted version (the tree only moves after
  # a successful verification) — setup.sh still runs, e.g. to reconfigure a proxy — with the advice
  # fitting the reason: a diverged install used to get none, and update.sh refuses it too (shell-r2#0).
  if ! update_existing_checkout "$INSTALL_DIR"; then
    echo "⚠️  Не обновил (причины выше) — остаюсь на установленной версии."
    explain_update_failure
    CHECKOUT_UNCHANGED=1
  fi
elif [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  # git clone refuses a non-empty directory; without this the failure read as "GitHub недоступен".
  echo "❌ $INSTALL_DIR не пуст и не является git-репозиторием: удалите мост через меню (пункт 3, с бэкапом) или укажите другой каталог"
  exit 1
elif GIT_TERMINAL_PROMPT=0 git clone "$REPO_URL" "$INSTALL_DIR"; then
  FRESH_CLONE=1 # cloned from GitHub
else
  echo "GitHub недоступен — устанавливаю с резервного зеркала..."
  git clone "$MIRROR_GIT_URL" "$INSTALL_DIR"
  FRESH_CLONE=1
  # Keep origin pointing at GitHub (the canonical source) so ordinary updates prefer it once it's
  # back; the mirror stays the fallback (see update.sh).
  git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
fi </dev/null  # same stdin guard as the apt calls — keep git off the curl|bash pipe

# A fresh clone is built only from a signed release (review 2026-09-26, shell-r1#0): it used to build
# main HEAD with no signature check at all, so a tampered mirror ran its own setup.sh as root. With
# none it goes again — git clone only succeeds into a new or empty directory, nothing of the user's is in it.
if [ "$FRESH_CLONE" -eq 1 ]; then
  if RELEASE=$(newest_signed_release "$INSTALL_DIR" HEAD) && git -C "$INSTALL_DIR" checkout -q -B main "$RELEASE^{commit}" </dev/null; then
    echo "Исходники на релизе ${RELEASE} (подпись проверена)."
  else
    rm -rf "$INSTALL_DIR"
    echo "❌ В скачанном репозитории нет релиза с действительной подписью — установка остановлена."
    echo "   Возможна подмена источника (GitHub/зеркала) или временный сбой. Повторите install.sh позже."
    exit 1
  fi
fi

cd "$INSTALL_DIR"

# Bootstrap-trust check (see EXPECTED_SIGNER above): the cloned repo must carry exactly the
# pinned release key. Missing file counts as failure — every release since v0.4.1 ships it.
if ! grep -qxF "$EXPECTED_SIGNER" allowed_signers 2>/dev/null; then
  # An existing checkout the update left untouched that predates allowed_signers (before v0.4.1) has
  # no key to check yet: still stopped, but not reported as a compromised source (review 2026-09-26,
  # b6-installer-docs); the advice fitting the reason was printed where the update failed (shell-r1#1).
  if [ "$CHECKOUT_UNCHANGED" -eq 1 ] && [ ! -e allowed_signers ]; then
    echo "❌ Установка слишком старая (до v0.4.1): в ней ещё нет ключа подписи релизов, и обновить её не вышло (что делать — см. выше)."
  else
    echo "❌ Ключ подписи релизов в скачанном репозитории не совпадает с ожидаемым."
    echo "   Возможна компрометация источника (GitHub/зеркала) — установка остановлена."
  fi
  exit 1
fi

# Clean reinstall (menu choice): wipe the configuration and the bridge state so setup.sh
# runs its first-time flow. The backup happens HERE, right before the wipe — not at menu
# time — so it captures the very last state. The git checkout stays (already updated above).
if [ "$CLEAN_REINSTALL" -eq 1 ]; then
  echo
  echo "Переустановка начисто: сбрасываю настройки и данные..."
  if ! BAK=$(backup_install "$INSTALL_DIR"); then
    echo "❌ Не удалось сохранить бэкап настроек и данных в /root — переустановку начисто отменяю, ничего не удалено."
    echo "   Проверьте место на диске (df -h /root) и запустите install.sh снова."
    exit 1
  fi
  if [ -n "$BAK" ]; then echo "  Старые настройки и данные сохранены: $BAK"; fi
  docker compose down -v --remove-orphans </dev/null 2>/dev/null || true
  rm -f .env
  rm -rf data
fi

echo
bold "Окружение готово, переходим к настройке."
echo
# The update above moved only the sources: the running container stays on its version until it is
# rebuilt, and leaving the menu with «0» rebuilds nothing (review 2026-09-27, shell-r3.1#1). Only when
# the container really runs another commit (its GIT_COMMIT, as update.sh reads it): an install already
# on the release was told to rebuild for nothing (shell-r3.2#0).
DEPLOYED=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(docker compose ps -q 2>/dev/null | head -1)" 2>/dev/null | sed -n 's/^GIT_COMMIT=//p' | head -1) || DEPLOYED=""
if [ "$FRESH_CLONE" -eq 0 ] && [ "$CHECKOUT_UNCHANGED" -eq 0 ] && [ -f .env ] && [ "$DEPLOYED" != "$(git rev-parse HEAD)" ]; then
  echo "ℹ️  Новая версия заработает после пересборки: в меню ниже выберите «6) Пересобрать и перезапустить контейнер»."
  echo
fi

# curl | bash consumes stdin for the script itself — reconnect to the real
# terminal so setup.sh's prompts (bot token, group id) actually work.
# `exec` replaces this shell, so the EXIT trap above will NOT fire — clean up here.
rm -f "$APT_NI_SNIPPET" "$SIGNERS"
exec ./setup.sh < /dev/tty
