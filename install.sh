#!/usr/bin/env bash
# One-command bootstrap for a bare Ubuntu/Debian server: system update, git,
# Docker, clone the repo, hand off to setup.sh for the interactive key setup.
#
# Usage (as root, on a fresh server):
#   curl -fsSL https://raw.githubusercontent.com/Trollobot/Telemax/main/install.sh | bash
#
# Safe to re-run: skips steps that are already done (git/Docker already
# installed, repo already cloned — pulls latest instead).
set -euo pipefail

REPO_URL="https://github.com/Trollobot/Telemax.git"
# Read-only fallback mirror for when GitHub is unreachable (account flagged, or GitHub filtered on
# this network). Overridable via env so the mirror can move without editing this script.
MIRROR_GIT_URL="${MIRROR_GIT_URL:-http://zergont-gate.duckdns.org:3200/Telemax.git}"
INSTALL_DIR="/opt/telemax"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root (на большинстве VPS вы и так root по SSH; иначе — sudo -i, затем повторите команду)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

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
apt_get() {
  if ! apt-get "$@"; then
    echo "⚠️  apt-get $* завершился с предупреждением (см. вывод выше) — похоже, дело в стороннем пакете, не связанном с Telemax. Продолжаю; если хотите разобраться отдельно, обычно помогает: dpkg --configure -a"
    dpkg --configure -a >/dev/null 2>&1 || true
  fi
}

bold "=== Telemax — установка на чистый сервер ==="
echo

echo "[1/5] Обновляю систему (может занять несколько минут)..."
apt-get update -y
apt_get upgrade -y

echo
echo "[2/5] Проверяю git и jq..."
# jq: used by setup.sh to auto-detect the Telegram group id (no need to hunt
# for it manually — see setup.sh).
for pkg in git jq; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    apt_get install -y "$pkg"
  fi
done

echo
echo "[3/5] Проверяю Docker..."
if ! command -v docker >/dev/null 2>&1; then
  # get.docker.com's own script calls apt-get install internally and can hit
  # the exact same recurring trigger issue — don't trust its exit code alone,
  # check whether docker actually landed afterward.
  curl -fsSL https://get.docker.com | sh || true
  if ! command -v docker >/dev/null 2>&1; then
    echo "❌ Docker всё ещё не установлен после попытки. Разберитесь с ошибкой apt выше (обычно: dpkg --configure -a), затем запустите install.sh заново."
    exit 1
  fi
else
  echo "Docker уже установлен."
fi
systemctl enable --now docker >/dev/null 2>&1 || true

echo
echo "[4/5] Скачиваю проект в $INSTALL_DIR..."
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Уже склонировано — обновляю до последней версии..."
  # GIT_TERMINAL_PROMPT=0 so a flagged/unreachable GitHub fails fast instead of hanging on a
  # credential prompt; then fall back to the mirror.
  GIT_TERMINAL_PROMPT=0 git -C "$INSTALL_DIR" pull --ff-only || {
    echo "GitHub недоступен — обновляю с резервного зеркала..."
    git -C "$INSTALL_DIR" fetch "$MIRROR_GIT_URL" main
    git -C "$INSTALL_DIR" merge --ff-only FETCH_HEAD
  }
elif GIT_TERMINAL_PROMPT=0 git clone "$REPO_URL" "$INSTALL_DIR"; then
  : # cloned from GitHub
else
  echo "GitHub недоступен — устанавливаю с резервного зеркала..."
  git clone "$MIRROR_GIT_URL" "$INSTALL_DIR"
  # Keep origin pointing at GitHub (the canonical source) so ordinary updates prefer it once it's
  # back; the mirror stays the fallback (see update.sh).
  git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
fi

cd "$INSTALL_DIR"
echo
bold "Окружение готово, переходим к настройке."
echo

# curl | bash consumes stdin for the script itself — reconnect to the real
# terminal so setup.sh's prompts (bot token, group id) actually work.
exec ./setup.sh < /dev/tty
