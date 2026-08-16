#!/usr/bin/env bash
# Interactive first-time setup for Telemax. Generates the two secret keys
# automatically, asks only for the two things nobody but you can provide
# (the Telegram bot token and target group id), writes .env, and offers to
# build + start the bridge right away.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# Waits until the container's HTTPS panel answers /health. MAX connects a moment
# after the container starts, so /auth/* would 503 if we asked too early. Expects
# API_URL set. Panel uses a self-signed cert generated on first start — hence -k.
wait_for_server() {
  echo "Жду готовности сервера..."
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    curl -sk --max-time 2 "$API_URL/health" >/dev/null 2>&1 && break
    sleep 2
  done
}

# Interactive MAX auth (phone -> SMS -> optional cloud password) against the running
# container's /api/auth/*, the same endpoints the web panel uses. Runs both on a
# fresh install and on the re-auth path below (an already-configured install where
# auth was never finished). Expects API_URL, API_KEY, HOST, PORT set; sets AUTHED=1
# on success.
run_max_auth() {
  echo
  echo "════════════════════════════════════════════════════════════════"
  bold "  ШАГ АВТОРИЗАЦИИ MAX — БЕЗ НЕГО МОСТ НЕ ЗАРАБОТАЕТ"
  echo "════════════════════════════════════════════════════════════════"
  echo "Введите номер MAX и код из SMS. Если пропустить (просто Enter) —"
  echo "контейнер останется запущенным, но НЕ подключённым к аккаунту, пока"
  echo "вы не авторизуетесь позже через веб-панель."
  echo
  AUTHED=""
  read -rp "Номер телефона MAX (с кодом страны, напр. +79991234567), или Enter чтобы позже: " MAX_PHONE
  if [ -n "$MAX_PHONE" ]; then
    PHONE_OK=""
    for attempt in 1 2 3; do
      PHONE_RESP=$(curl -sk -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
        -d "{\"phone\":\"$MAX_PHONE\"}" "$API_URL/auth/phone")
      if echo "$PHONE_RESP" | grep -q '"success":true'; then
        PHONE_OK=1
        break
      fi
      sleep 2
    done
    if [ -n "$PHONE_OK" ]; then
      echo "Код отправлен на $MAX_PHONE."
      read -rp "Код из SMS: " MAX_CODE
      VERIFY_RESP=$(curl -sk -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
        -d "{\"code\":\"$MAX_CODE\"}" "$API_URL/auth/verify")
      if echo "$VERIFY_RESP" | grep -q '"passwordRequired":true'; then
        # Some MAX accounts have a password set as a second factor on top of SMS.
        # A wrong password can be retried freely — the auth session behind it
        # doesn't expire until a correct one goes through (confirmed live 2026-08-14).
        HINT=$(echo "$VERIFY_RESP" | grep -o '"hint":"[^"]*"' | sed 's/"hint":"//;s/"$//')
        echo "Этот MAX-аккаунт защищён паролем (второй фактор поверх SMS)."
        [ -n "$HINT" ] && echo "Подсказка: $HINT"
        PASSWORD_OK=""
        while [ -z "$PASSWORD_OK" ]; do
          read -rsp "Пароль: " MAX_PASSWORD
          echo
          PASSWORD_RESP=$(curl -sk -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
            -d "{\"password\":\"$MAX_PASSWORD\"}" "$API_URL/auth/password")
          if echo "$PASSWORD_RESP" | grep -q '"success":true'; then
            PASSWORD_OK=1
            AUTHED=1
            bold "Готово — мост авторизован и подключён к MAX."
          else
            echo "❌ Неверный пароль, попробуйте ещё раз (или Ctrl+C — тогда через веб-панель: https://$HOST:$PORT)."
          fi
        done
      elif echo "$VERIFY_RESP" | grep -q '"success":true'; then
        AUTHED=1
        bold "Готово — мост авторизован и подключён к MAX."
      else
        echo "❌ Не удалось подтвердить код: $VERIFY_RESP"
        echo "Попробуйте ещё раз через веб-панель: https://$HOST:$PORT"
      fi
    else
      echo "❌ Не удалось запросить SMS: $PHONE_RESP"
      echo "Попробуйте через веб-панель: https://$HOST:$PORT"
    fi
  else
    echo "Ок — авторизацию можно завершить позже через веб-панель (см. ниже)."
  fi
}

# Big, unmissable closing summary — authed vs not, plus the panel URL and key.
# Expects AUTHED, HOST, PORT, API_KEY.
print_final_status() {
  echo
  echo "════════════════════════════════════════════════════════════════"
  if [ -n "$AUTHED" ]; then
    bold "  ✅ ГОТОВО. Мост авторизован, запущен и подключён к MAX."
  else
    bold "  ⚠️  МОСТ ЗАПУЩЕН, НО MAX ПОКА НЕ АВТОРИЗОВАН"
    echo "  Без авторизации сообщения не будут пересылаться. Завершите её:"
    echo "  откройте https://$HOST:$PORT, введите ключ ниже, затем номер и код из SMS."
  fi
  echo "════════════════════════════════════════════════════════════════"
  echo "  Веб-панель:  https://$HOST:$PORT"
  echo "  Ключ входа:  $API_KEY"
  echo "  (сертификат самоподписанный — браузер предупредит один раз:"
  echo "   «Дополнительно» → «Перейти на сайт». Ключ можно вернуть командой /apikey у бота.)"
  echo "════════════════════════════════════════════════════════════════"
}

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

if [ -f .env ]; then
  # Already configured — but the MAX auth step might never have been finished
  # (interrupted mid-flow, or only the bot/group part was done, or the account
  # has a cloud password and the person bailed at that prompt). Re-running the
  # installer used to just say "нечего делать" and exit, leaving the web panel as
  # the only recovery path. Instead: check whether MAX is actually authorized and,
  # if not, offer to finish it right here in the console.
  set -a
  # shellcheck disable=SC1091
  . ./.env 2>/dev/null || true
  set +a
  PORT="${PORT:-3000}"
  API_URL="https://localhost:$PORT/api"
  PUBLIC_IP=$(curl -s --max-time 3 ifconfig.me || true)
  HOST="${PUBLIC_IP:-<адрес-сервера>}"

  if ! command -v docker >/dev/null 2>&1; then
    echo ".env уже существует, но Docker недоступен на этой машине —"
    echo "запустите контейнер там, где есть Docker, и авторизуйтесь через веб-панель."
    exit 0
  fi

  if [ -z "$(docker compose ps --status running --format '{{.Name}}' 2>/dev/null)" ]; then
    read -rp ".env есть, но контейнер не запущен. Запустить сейчас? [Y/n] " RUN_NOW
    if [ "${RUN_NOW:-Y}" = "n" ] || [ "${RUN_NOW:-Y}" = "N" ]; then
      echo "Ок. Когда будете готовы: docker compose up -d, затем ./setup.sh или веб-панель."
      exit 0
    fi
    GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown) docker compose up -d --build
  fi

  wait_for_server
  # /api/status returns the active phone once MAX is authorized; empty until then.
  STATUS=$(curl -sk --max-time 3 -H "x-api-key: ${API_KEY:-}" "$API_URL/status" 2>/dev/null || true)
  if echo "$STATUS" | grep -q '"phone":"[^"]'; then
    echo "✅ Уже настроено и авторизовано в MAX. Ничего делать не нужно."
    echo "   Веб-панель: https://$HOST:$PORT"
    exit 0
  fi

  echo
  bold "⚠️  .env есть, но MAX ещё не авторизован — шаг авторизации не завершён."
  read -rp "Пройти авторизацию сейчас? [Y/n] " DO_AUTH
  if [ "${DO_AUTH:-Y}" = "n" ] || [ "${DO_AUTH:-Y}" = "N" ]; then
    echo "Ок — можно позже через веб-панель: https://$HOST:$PORT (ключ: /apikey у бота или grep API_KEY .env)."
    exit 0
  fi
  run_max_auth
  print_final_status
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Не найден openssl — он нужен, чтобы сгенерировать ключи. Установите его (обычно уже есть на Ubuntu/Debian: apt install openssl) и запустите скрипт снова."
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

# Starting from $1, returns the first port nothing is already listening on
# locally. Used instead of hard-failing when 3000 is taken (e.g. a leftover
# container from an earlier install attempt) — just use the next one free.
find_free_port() {
  local port=$1
  while (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do
    exec 3>&- 3<&-
    port=$((port + 1))
  done
  echo "$port"
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
echo "http://[логин:пароль@]хост:порт."
read -rp "Прокси для Telegram (Enter — без прокси): " TELEGRAM_PROXY
TG_PROXY_ARGS=()
if [ -n "$TELEGRAM_PROXY" ]; then
  TG_PROXY_ARGS=(--proxy "$TELEGRAM_PROXY")
fi

echo
echo "Проверяю связь с серверами MAX и Telegram..."
NETWORK_OK=1
if check_tcp 155.212.204.150 443; then
  echo "  MAX (155.212.204.150:443): OK"
else
  echo "  MAX (155.212.204.150:443): нет связи"
  NETWORK_OK=0
fi
if [ -n "$TELEGRAM_PROXY" ]; then
  if curl -sS "${TG_PROXY_ARGS[@]}" --max-time 8 -o /dev/null https://api.telegram.org 2>/dev/null; then
    echo "  Telegram (через прокси): OK"
  else
    echo "  Telegram (через прокси): нет связи — проверьте адрес/логин/пароль прокси"
    NETWORK_OK=0
  fi
elif check_tcp api.telegram.org 443; then
  echo "  Telegram (api.telegram.org:443): OK"
else
  echo "  Telegram (api.telegram.org:443): нет связи"
  NETWORK_OK=0
fi
if [ "$NETWORK_OK" -eq 0 ]; then
  echo
  echo "Без связи хотя бы с одним из серверов мост работать не сможет. Проверьте"
  echo "файрвол/провайдера сети (некоторые хостинги или страны блокируют MAX"
  echo "и/или Telegram) и запустите setup.sh снова."
  exit 1
fi
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
echo "  3. Отправьте в группу любое сообщение — id вычислю сам, ничего искать не нужно."
echo

TARGET_TELEGRAM_GROUP=""
if command -v jq >/dev/null 2>&1; then
  read -rp "Сделали? Нажмите Enter, когда отправите сообщение в группу... "
  echo "Ищу группу..."
  for attempt in 1 2 3 4 5; do
    UPDATES=$(curl -s "${TG_PROXY_ARGS[@]}" "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100" || true)
    TARGET_TELEGRAM_GROUP=$(echo "$UPDATES" | jq -r '
      [.result[] | (.message // .channel_post // empty)
       | select(.chat.type == "supergroup" or .chat.type == "group")
       | .chat.id] | last // empty' 2>/dev/null || true)
    if [ -n "$TARGET_TELEGRAM_GROUP" ]; then
      echo "Нашёл группу, id: $TARGET_TELEGRAM_GROUP"
      break
    fi
    echo "  Пока не вижу сообщений от бота в группе, жду 3с и пробую снова ($attempt/5)..."
    sleep 3
  done
else
  echo "(jq не найден — автоопределение пропущено, введите id вручную)"
fi

if [ -z "$TARGET_TELEGRAM_GROUP" ]; then
  echo
  echo "Не нашёл автоматически. Id группы можно узнать, например, переслав любое"
  echo "сообщение из неё боту @getidsbot."
  read -rp "Id группы (TARGET_TELEGRAM_GROUP, вида -100...): " TARGET_TELEGRAM_GROUP
  while [ -z "$TARGET_TELEGRAM_GROUP" ]; do
    read -rp "Id не может быть пустым, введите ещё раз: " TARGET_TELEGRAM_GROUP
  done
fi

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

API_KEY=$(openssl rand -hex 24)
MAX_SESSION_KEY=$(openssl rand -hex 32)

PORT=$(find_free_port 3000)
if [ "$PORT" != "3000" ]; then
  echo "Порт 3000 занят — использую $PORT вместо него."
fi

# .env carries every secret this install has (API key, session-encryption key,
# bot token) — don't leave it readable to other local users.
umask 077
cat > .env <<EOF
# сгенерировано setup.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)
API_KEY=$API_KEY
MAX_SESSION_KEY=$MAX_SESSION_KEY
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TARGET_TELEGRAM_GROUP=$TARGET_TELEGRAM_GROUP
PORT=$PORT
TELEGRAM_PROXY=$TELEGRAM_PROXY
EOF

echo
bold "Готово: .env создан."
echo "Ключ для входа в веб-панель (сохраните — если потеряете, его всегда можно"
echo "запросить снова у бота командой /apikey прямо в вашей Telegram-группе):"
bold "  $API_KEY"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден на этой машине — установите Docker и Docker Compose, затем запустите:"
  echo "  docker compose up -d --build"
  exit 0
fi

read -rp "Собрать и запустить контейнер прямо сейчас? [Y/n] " RUN_NOW
if [ "${RUN_NOW:-Y}" = "n" ] || [ "${RUN_NOW:-Y}" = "N" ]; then
  echo "Ок, когда будете готовы: docker compose up -d --build"
  exit 0
fi

echo
echo "Собираю образ — первая сборка дольше обычного (внутри headless-браузер для рендера стикеров), обычно несколько минут."
GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown) docker compose up -d --build

PUBLIC_IP=$(curl -s --max-time 3 ifconfig.me || true)
HOST="${PUBLIC_IP:-<адрес-сервера>}"

echo
bold "Контейнер собран и запущен. Остался ОДИН обязательный шаг ниже."

# Авторизация в MAX прямо здесь, без переключения в браузер — тот же /api/auth/*,
# которым пользуется веб-панель, просто из консоли.
API_URL="https://localhost:$PORT/api"
wait_for_server
run_max_auth
print_final_status
