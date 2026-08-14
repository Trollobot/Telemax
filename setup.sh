#!/usr/bin/env bash
# Interactive first-time setup for Telemax. Generates the two secret keys
# automatically, asks only for the two things nobody but you can provide
# (the Telegram bot token and target group id), writes .env, and offers to
# build + start the bridge right away.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

if [ -f .env ]; then
  echo ".env уже существует — настройка не нужна."
  echo "Если хотите начать заново: удалите .env и запустите setup.sh снова."
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Не найден openssl — он нужен, чтобы сгенерировать ключи. Установите его (обычно уже есть на Ubuntu/Debian: apt install openssl) и запустите скрипт снова."
  exit 1
fi

bold "=== Telemax — первая настройка ==="
echo

# Fails fast on a server whose network can't reach one of the two services this
# bridge depends on (firewall, geo-blocking, restrictive hosting policy) —
# better to say so now than after the user has typed in a bot token.
check_tcp() {
  timeout 5 bash -c "cat < /dev/null > /dev/tcp/$1/$2" 2>/dev/null
}

echo "Проверяю связь с серверами MAX и Telegram..."
NETWORK_OK=1
if check_tcp 155.212.204.150 443; then
  echo "  MAX (155.212.204.150:443): OK"
else
  echo "  MAX (155.212.204.150:443): нет связи"
  NETWORK_OK=0
fi
if check_tcp api.telegram.org 443; then
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
echo "  2. Добавьте бота в группу как администратора."
echo "  3. Отправьте в группу любое сообщение — id вычислю сам, ничего искать не нужно."
echo

TARGET_TELEGRAM_GROUP=""
if command -v jq >/dev/null 2>&1; then
  read -rp "Сделали? Нажмите Enter, когда отправите сообщение в группу... "
  echo "Ищу группу..."
  for attempt in 1 2 3 4 5; do
    UPDATES=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100" || true)
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

API_KEY=$(openssl rand -hex 24)
MAX_SESSION_KEY=$(openssl rand -hex 32)

cat > .env <<EOF
# сгенерировано setup.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)
API_KEY=$API_KEY
MAX_SESSION_KEY=$MAX_SESSION_KEY
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TARGET_TELEGRAM_GROUP=$TARGET_TELEGRAM_GROUP
PORT=3000
EOF

echo
bold "Готово: .env создан."
echo "Ключ для входа в веб-панель (сохраните, он больше нигде не покажется):"
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
docker compose up -d --build

PUBLIC_IP=$(curl -s --max-time 3 ifconfig.me || true)
HOST="${PUBLIC_IP:-<адрес-сервера>}"

echo
bold "Мост запущен."
echo "Откройте http://$HOST:3000, введите ключ выше, затем номер телефона MAX и код из SMS."
