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
trap 'rm -f "$APT_NI_SNIPPET"' EXIT
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
  if ! apt-get "$@" </dev/null; then
    echo "⚠️  apt-get $* завершился с предупреждением (см. вывод выше) — похоже, дело в стороннем пакете, не связанном с Telemax. Продолжаю; если хотите разобраться отдельно, обычно помогает: dpkg --configure -a"
    # With the force flags, a pending configure that was waiting on a conffile prompt actually
    # completes here instead of dying on the same question (which is what used to happen).
    dpkg --configure -a $DPKG_NI >/dev/null 2>&1 </dev/null || true
  fi
}

bold "=== Telemax — установка на чистый сервер ==="
echo

echo "[1/6] Обновляю систему (может занять несколько минут)..."
apt_get update -y
apt_get upgrade -y

echo
echo "[2/6] Проверяю git и jq..."
# jq: used by setup.sh to auto-detect the Telegram group id (no need to hunt for it
# manually — see setup.sh). (update.sh's release-signature check uses ssh-keygen, which
# ships with openssh and is already present on any host you can SSH into — no extra pkg.)
for pkg in git jq; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    apt_get install -y "$pkg"
  fi
done

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
    echo "❌ Docker всё ещё не установлен после попытки. Разберитесь с ошибкой apt выше (обычно: dpkg --configure -a), затем запустите install.sh заново."
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
echo
echo "[5/6] Скачиваю проект в $INSTALL_DIR..."
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
# `exec` replaces this shell, so the EXIT trap above will NOT fire — remove the snippet here.
rm -f "$APT_NI_SNIPPET"
exec ./setup.sh < /dev/tty
