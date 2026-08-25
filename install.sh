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
MIRROR_GIT_URL="${MIRROR_GIT_URL:-https://zergont-gate.duckdns.org/Telemax.git}"
INSTALL_DIR="/opt/telemax"
# The maintainer's release-signing key, pinned HERE as well as in the repo's allowed_signers:
# update.sh trusts whatever allowed_signers the checkout carries, so a tampered clone (a
# compromised transport swapping in an attacker's key) would otherwise bootstrap a poisoned
# trust chain. As long as THIS script arrived over HTTPS, the check below catches that swap.
EXPECTED_SIGNER='release@telemax namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILE1HMFVabDZUp6fRrnnt2lMgTY57ghrMP1pp+dE5MIe'

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
# `</dev/null` on every apt/dpkg call is critical under `curl | bash`: bash reads THIS script from
# stdin (the pipe), and a package maintainer script that reads stdin during `apt upgrade` (grub,
# cloud-init, …) would otherwise consume the rest of the script and the install silently stops after
# that step (hit live on a fresh Ubuntu 24.04 box). Giving apt its own empty stdin keeps the pipe
# — and the rest of this script — intact for bash.
apt_get() {
  if ! apt-get "$@" </dev/null; then
    echo "⚠️  apt-get $* завершился с предупреждением (см. вывод выше) — похоже, дело в стороннем пакете, не связанном с Telemax. Продолжаю; если хотите разобраться отдельно, обычно помогает: dpkg --configure -a"
    dpkg --configure -a >/dev/null 2>&1 </dev/null || true
  fi
}

bold "=== Telemax — установка на чистый сервер ==="
echo

echo "[1/5] Обновляю систему (может занять несколько минут)..."
apt-get update -y </dev/null
apt_get upgrade -y

echo
echo "[2/5] Проверяю git и jq..."
# jq: used by setup.sh to auto-detect the Telegram group id (no need to hunt for it
# manually — see setup.sh). (update.sh's release-signature check uses ssh-keygen, which
# ships with openssh and is already present on any host you can SSH into — no extra pkg.)
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
fi </dev/null  # same stdin guard as the apt calls — keep git off the curl|bash pipe

cd "$INSTALL_DIR"

# Bootstrap-trust check (see EXPECTED_SIGNER above): the cloned repo must carry exactly the
# pinned release key. Missing file counts as failure — every release since v0.4.1 ships it.
if ! grep -qxF "$EXPECTED_SIGNER" allowed_signers 2>/dev/null; then
  echo "❌ Ключ подписи релизов в скачанном репозитории не совпадает с ожидаемым."
  echo "   Возможна компрометация источника (GitHub/зеркала) — установка остановлена."
  exit 1
fi

echo
bold "Окружение готово, переходим к настройке."
echo

# curl | bash consumes stdin for the script itself — reconnect to the real
# terminal so setup.sh's prompts (bot token, group id) actually work.
exec ./setup.sh < /dev/tty
