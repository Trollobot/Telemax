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
INSTALL_DIR="/opt/telemax"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root (на большинстве VPS вы и так root по SSH; иначе — sudo -i, затем повторите команду)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

bold "=== Telemax — установка на чистый сервер ==="
echo

echo "[1/5] Обновляю систему (может занять несколько минут)..."
apt-get update -y
apt-get upgrade -y

echo
echo "[2/5] Проверяю git и jq..."
# jq: used by setup.sh to auto-detect the Telegram group id (no need to hunt
# for it manually — see setup.sh).
for pkg in git jq; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    apt-get install -y "$pkg"
  fi
done

echo
echo "[3/5] Проверяю Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "Docker уже установлен."
fi
systemctl enable --now docker >/dev/null 2>&1 || true

echo
echo "[4/5] Скачиваю проект в $INSTALL_DIR..."
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Уже склонировано — обновляю до последней версии..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo
bold "Окружение готово, переходим к настройке."
echo

# curl | bash consumes stdin for the script itself — reconnect to the real
# terminal so setup.sh's prompts (bot token, group id) actually work.
exec ./setup.sh < /dev/tty
