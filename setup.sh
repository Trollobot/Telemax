#!/usr/bin/env bash
# Interactive first-time setup for Telemax (v0.4 — headless, no web panel).
# Generates the session-encryption key automatically, asks only for the two things
# nobody but you can provide (the Telegram bot token and target group), lets you pick
# the image size (animated stickers on/off), writes .env, and builds + starts the
# bridge. MAX authorization happens afterwards IN THE BOT: send /login to it in a DM.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# Runs on every invocation, even on an already-configured install (the .env
# check below exits before the rest of setup) — an update pulled in via the
# watcher itself needs the watcher already installed to have gotten here, and
# re-running enable is harmless, so this is the one place that's safe to do
# unconditionally.
if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1; then
  REPO_DIR="$(pwd)"
  # systemd services run with a stripped environment (notably a different or
  # unset $HOME), so git's "dubious ownership" check can reject the repo even
  # when a normal interactive `git config --global` already covers it for an
  # SSH session as the same user — hit live 2026-08-14, silently broke every
  # update the watcher tried to run. --system doesn't depend on $HOME at all.
  git config --system --add safe.directory "$REPO_DIR" 2>/dev/null || true
  cat > /etc/systemd/system/telemax-updater.service <<EOF
[Unit]
Description=Telemax update watcher (one-shot)

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
ExecStart=$REPO_DIR/update-watcher.sh
EOF
  cat > /etc/systemd/system/telemax-updater.timer <<'EOF'
[Unit]
Description=Run the Telemax update watcher every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
Unit=telemax-updater.service

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now telemax-updater.timer >/dev/null 2>&1
  echo "Вотчер обновлений (telemax-updater, systemd-таймер) установлен и включён в автозапуск — см. README."
else
  echo "Пропускаю установку вотчера обновлений — нужны root и systemd. Обновляться придётся вручную: ./update.sh"
fi

# Already configured — nothing to re-ask. If MAX isn't authorized yet, that's now
# a one-liner in the bot (/login), so we don't need the old console-auth flow.
if [ -f .env ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo ".env уже существует, но Docker недоступен на этой машине — запустите контейнер там, где есть Docker."
    exit 0
  fi
  if [ -z "$(docker compose ps --status running --format '{{.Name}}' 2>/dev/null)" ]; then
    read -rp ".env есть, но контейнер не запущен. Запустить сейчас? [Y/n] " RUN_NOW
    if [ "${RUN_NOW:-Y}" = "n" ] || [ "${RUN_NOW:-Y}" = "N" ]; then
      echo "Ок. Когда будете готовы: docker compose up -d"
      exit 0
    fi
    GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown) docker compose up -d --build
  fi
  echo "✅ Уже настроено и запущено."
  echo "   Если MAX ещё не авторизован — напишите боту в ЛИЧКУ: /login (или в группе: /panel → «🔐 Вход в MAX»)."
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Не найден openssl — он нужен для генерации ключа шифрования сессии. Установите (apt install openssl) и запустите скрипт снова."
  exit 1
fi

bold "=== Telemax — первая настройка ==="
echo

# A leftover container from a previous attempt (e.g. .env was deleted to redo
# setup, but the container itself was never stopped) keeps long-polling
# Telegram with its own bot token — races the getUpdates call below and
# silently breaks group auto-detection. Confirmed live 2026-08-14.
if command -v docker >/dev/null 2>&1; then
  RUNNING=$(docker compose ps --status running --format '{{.Name}}' 2>/dev/null || true)
  if [ -n "$RUNNING" ]; then
    echo "⚠️  Уже запущен контейнер предыдущей установки: $RUNNING"
    echo "Пока он работает, его бот перехватывает Telegram-обновления — автоопределение"
    echo "группы ниже не найдёт сообщение."
    read -rp "Остановить его сейчас? [Y/n] " STOP_OLD
    if [ "${STOP_OLD:-Y}" != "n" ] && [ "${STOP_OLD:-Y}" != "N" ]; then
      docker compose down
      echo "Остановлено."
    fi
    echo
  fi
fi

# Fails fast on a server whose network can't reach one of the two services this
# bridge depends on (firewall, geo-blocking, restrictive hosting policy) —
# better to say so now than after the user has typed in a bot token. Retries a
# few times first: a single attempt right after boot can spuriously fail on a
# transient blip (DNS not warmed up yet, a flaky first packet) even though the
# server is perfectly reachable a couple seconds later — confirmed live.
check_tcp() {
  for attempt in 1 2 3; do
    if timeout 5 bash -c "cat < /dev/null > /dev/tcp/$1/$2" 2>/dev/null; then
      return 0
    fi
    [ "$attempt" -lt 3 ] && sleep 2
  done
  return 1
}

# Ask about a Telegram proxy BEFORE the reachability check: on a host where Telegram
# is reachable only through a proxy (e.g. a home server with no direct route to
# api.telegram.org), a direct check would falsely fail and abort setup. MAX always
# stays direct. The value doubles as its own validation via the check below and is
# written to .env as TELEGRAM_PROXY (the container's Telegraf client picks it up).
echo
echo "Если этот сервер выходит в Telegram только через прокси (напр. домашний"
echo "сервер, где прямой доступ к api.telegram.org закрыт) — укажите его. MAX при"
echo "этом идёт напрямую. Форматы: socks5://[логин:пароль@]хост:порт или"
echo "http://[логин:пароль@]хост:порт. Ошибётесь — проверка ниже даст поправить."
read -rp "Прокси для Telegram (Enter — без прокси): " TELEGRAM_PROXY

echo
echo "Проверяю связь с серверами MAX и Telegram..."

# MAX is fatal: it's always direct, so nothing the user could re-type fixes a blocked
# MAX — a firewall/geo-block is an environment problem, not a typo. Checked by NAME so
# an IPv6-only host resolves via DNS64/NAT64 (MAX itself is IPv4-only).
if check_tcp api2.oneme.ru 443; then
  echo "  MAX (api2.oneme.ru:443): OK"
else
  echo "  MAX (api2.oneme.ru:443): нет связи"
  echo
  echo "Без связи с сервером MAX мост работать не сможет — обычно это файрвол хостинга"
  echo "или гео-блокировка. На IPv6-only хосте нужен NAT64/DNS64 у провайдера. Проверьте"
  echo "сеть сервера и запустите setup.sh снова."
  exit 1
fi

# Telegram is NOT fatal: the usual cause is a mistyped proxy (or a host that needs a
# proxy at all) — both fixable right here. So loop and let the user re-enter the proxy
# and re-check instead of aborting, with an explicit "skip" escape so a genuinely
# blocked host isn't a dead end (the proxy can still be set later in .env).
while true; do
  TG_PROXY_ARGS=()
  if [ -n "$TELEGRAM_PROXY" ]; then
    TG_PROXY_ARGS=(--proxy "$TELEGRAM_PROXY")
    if curl -sS "${TG_PROXY_ARGS[@]}" --max-time 8 -o /dev/null https://api.telegram.org 2>/dev/null; then
      echo "  Telegram (через прокси): OK"
      break
    fi
    echo "  Telegram через прокси недоступен — возможно, неверный адрес/логин/пароль прокси."
  else
    if check_tcp api.telegram.org 443; then
      echo "  Telegram (api.telegram.org:443): OK"
      break
    fi
    echo "  Telegram напрямую недоступен (частая причина на хостингах в РФ — блокировка; помогает прокси)."
  fi
  echo "    • впишите прокси (socks5://… или http://…) и Enter — перепроверю через него;"
  echo "    • пустой Enter — перепроверить напрямую, без прокси;"
  echo "    • skip — продолжить установку без проверки (прокси можно задать позже в .env)."
  read -rp "  > " TG_INPUT
  if [ "$TG_INPUT" = "skip" ]; then
    echo "  Пропускаю проверку Telegram. Мост поднимется, но без связи с Telegram пересылки"
    echo "  не будет — задайте TELEGRAM_PROXY в .env и пересоберите."
    break
  fi
  TELEGRAM_PROXY="$TG_INPUT"
done
echo
echo "Понадобится токен бота — создайте его через @BotFather (https://t.me/BotFather), команда /newbot."
echo

read -rp "Токен бота (TELEGRAM_BOT_TOKEN): " TELEGRAM_BOT_TOKEN
while [ -z "$TELEGRAM_BOT_TOKEN" ]; do
  read -rp "Токен не может быть пустым, введите ещё раз: " TELEGRAM_BOT_TOKEN
done

echo
bold "Теперь группа:"
echo "  1. Создайте Telegram-группу (или возьмите существующую) и включите в ней Темы:"
echo "     настройки группы → Темы → включить."
echo "  2. Добавьте бота в группу администратором — ОБЯЗАТЕЛЬНО включите ему право"
echo "     «Управление темами» (Manage Topics), оно не входит в базовый набор прав."
echo "  3. id группы определю сам. Если несколько групп — дам выбрать."
echo "     Не подхватится сразу — просто ✍️ напишите в группу любое сообщение, и я её замечу."
echo

TARGET_TELEGRAM_GROUP=""
if ! command -v jq >/dev/null 2>&1; then
  echo "❌ Не найден jq — без него не могу определить группу. Установите: apt-get install -y jq — и запустите setup.sh заново."
  exit 1
fi

read -rp "Сделали? Нажмите Enter, когда бот добавлен в группу администратором... "
while [ -z "$TARGET_TELEGRAM_GROUP" ]; do
  echo "Ищу группу..."
  TG_GROUPS=""
  for attempt in 1 2 3 4 5 6; do
    UPDATES=$(curl -s "${TG_PROXY_ARGS[@]}" "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100" || true)
    # Собираем группы, которые бот «видел» — из сообщений И из события my_chat_member
    # (бота добавили/сделали админом). Второе приходит на обязательном шаге «сделать
    # админом», не зависит от того, отправит ли пользователь сообщение и попадёт ли в окно.
    TG_GROUPS=$(echo "$UPDATES" | jq -r '
      [ .result[]
        | ( (.message // .channel_post // .my_chat_member // empty) | .chat )
        | select(.type == "supergroup" or .type == "group")
        | {id, title: (.title // "без названия")} ]
      | unique_by(.id) | .[] | "\(.id)\t\(.title)"' 2>/dev/null || true)
    [ -n "$TG_GROUPS" ] && break
    echo "  Пока не вижу бота в группе, жду 3с ($attempt/6)..."
    sleep 3
  done

  if [ -z "$TG_GROUPS" ]; then
    echo
    echo "Пока не вижу группу. Чаще всего помогает одно:"
    echo "   ✍️  НАПИШИТЕ В ГРУППУ ЛЮБОЕ СООБЩЕНИЕ — и я её сразу замечу."
    echo "   (бот «видит» группу по свежему сообщению; если его добавили давно, событие о добавлении"
    echo "    могло не попасть в окно обновлений — сообщение это чинит.)"
    echo "Заодно проверьте, что бот ДОБАВЛЕН в нужную группу и он АДМИНИСТРАТОР с правом"
    echo "«Управление темами» (Manage Topics)."
    read -rp "Сделайте это и нажмите Enter, чтобы попробовать снова... "
    continue
  fi

  mapfile -t GROUP_LINES <<< "$TG_GROUPS"
  if [ "${#GROUP_LINES[@]}" -eq 1 ]; then
    TARGET_TELEGRAM_GROUP="${GROUP_LINES[0]%%$'\t'*}"
    echo "Нашёл группу: «${GROUP_LINES[0]#*$'\t'}» ($TARGET_TELEGRAM_GROUP)"
  else
    echo
    echo "Бот состоит в нескольких группах — выберите целевую:"
    for i in "${!GROUP_LINES[@]}"; do
      printf "  %d) %s  (%s)\n" "$((i + 1))" "${GROUP_LINES[$i]#*$'\t'}" "${GROUP_LINES[$i]%%$'\t'*}"
    done
    while [ -z "$TARGET_TELEGRAM_GROUP" ]; do
      read -rp "Номер: " choice
      if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#GROUP_LINES[@]}" ]; then
        TARGET_TELEGRAM_GROUP="${GROUP_LINES[$((choice - 1))]%%$'\t'*}"
        echo "Выбрана: «${GROUP_LINES[$((choice - 1))]#*$'\t'}» ($TARGET_TELEGRAM_GROUP)"
      else
        echo "  Нет такого номера, попробуйте ещё раз."
      fi
    done
  fi
done

# Best-effort — needs the bot to already be a group admin with "Change Group
# Info" rights, which setup already asked for above. setChatPhoto needs an
# actual file upload (multipart), not a URL, unlike sendPhoto.
AVATAR="$(dirname "$0")/assets/group-avatar.png"
if [ -f "$AVATAR" ]; then
  if curl -s "${TG_PROXY_ARGS[@]}" -F "chat_id=$TARGET_TELEGRAM_GROUP" -F "photo=@$AVATAR" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatPhoto" | grep -q '"ok":true'; then
    echo "Аватарка группы установлена."
  else
    echo "Не удалось установить аватарку группы (не критично, можно поставить вручную)."
  fi
fi

MAX_SESSION_KEY=$(openssl rand -hex 32)

# Animated stickers (.tgs) — the one real image-size knob. Rendering them to playable
# video needs a headless Chromium + ffmpeg (~1.4 GB); opting out ("slim") relays them as
# a static picture instead and keeps the image ~0.3 GB with a much faster build. 30-second
# timeout so an unattended install isn't blocked — defaults to full.
echo
echo "Анимированные стикеры (.tgs):"
echo "  • FULL (по умолчанию) — проигрываются как видео. Образ +~1.4 ГБ (Chromium+ffmpeg), сборка дольше."
echo "  • SLIM — уходят статической картинкой. Образ ~0.3 ГБ, быстрая сборка."
STICKERS=full
if read -t 30 -rp "Впишите slim для лёгкого образа, или Enter (жду 30с) — оставить full: " STICKERS_CHOICE; then
  case "${STICKERS_CHOICE:-}" in
    slim | SLIM | s | S) STICKERS=slim ;;
    *) STICKERS=full ;;
  esac
else
  echo
  echo "  (30с прошло — оставляю full)"
fi
echo "  → образ: $STICKERS"

# .env carries the session-encryption key and bot token — don't leave it readable to
# other local users. STICKERS is read by docker-compose.yml as a build arg.
umask 077
cat > .env <<EOF
# сгенерировано setup.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)
MAX_SESSION_KEY=$MAX_SESSION_KEY
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TARGET_TELEGRAM_GROUP=$TARGET_TELEGRAM_GROUP
TELEGRAM_PROXY=$TELEGRAM_PROXY
STICKERS=$STICKERS
EOF

echo
bold "Готово: .env создан."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден — установите Docker и Docker Compose, затем: docker compose up -d --build"
  exit 0
fi

read -rp "Собрать и запустить контейнер прямо сейчас? [Y/n] " RUN_NOW
if [ "${RUN_NOW:-Y}" = "n" ] || [ "${RUN_NOW:-Y}" = "N" ]; then
  echo "Ок, когда будете готовы: docker compose up -d --build"
  exit 0
fi

echo
if [ "$STICKERS" = "full" ]; then
  echo "Собираю образ (full) — первая сборка дольше (внутри headless-браузер для стикеров), обычно несколько минут."
else
  echo "Собираю образ (slim) — быстрая сборка."
fi
GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown) docker compose up -d --build

echo
echo "════════════════════════════════════════════════════════════════"
bold "  ✅ Мост собран и запущен. Остался ОДИН обязательный шаг: авторизация MAX."
echo "  Откройте вашего бота в Telegram и напишите ему в ЛИЧКУ команду:"
bold "      /login"
echo "  Введёте номер MAX и код из SMS прямо в личке — в группу они не попадут."
echo "  (Альтернатива: в группе /panel → «🔐 Вход в MAX».)"
echo "════════════════════════════════════════════════════════════════"
