#!/usr/bin/env bash
# Interactive setup for Telemax (v0.4 — headless, no web panel).
#
# First run: generates the session-encryption key automatically, asks only for the
# things nobody but you can provide (the Telegram bot token and target group), lets
# you pick the image size (animated stickers on/off), writes .env and builds + starts
# the bridge. MAX authorization happens afterwards IN THE BOT: send /login to it in a DM.
#
# Re-run on a configured install (.env exists): opens a settings menu instead —
# show/change the Telegram proxy (with a live connectivity test BEFORE saving),
# change the bot token / target group, switch the sticker image mode, re-check
# connectivity, rebuild. This is the sanctioned way to change settings after the
# web panel was removed in v0.4 — everything lives in .env, this menu edits it.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# Runs on every invocation, even on an already-configured install — an update
# pulled in via the watcher itself needs the watcher already installed to have
# gotten here, and re-running enable is harmless, so this is the one place
# that's safe to do unconditionally.
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

# ---------------------------------------------------------------------------
# Shared helpers — used by BOTH the first-run flow and the settings menu below.
# ---------------------------------------------------------------------------

# First 6 + last 4 chars of the bot token — enough to recognize it, useless to steal.
mask_token() {
  local t="$1"
  if [ "${#t}" -le 12 ]; then printf '***'; else printf '%s…%s' "${t:0:6}" "${t: -4}"; fi
}

# Proxy URL with any user:pass@ stripped — safe to print (mirrors src/telegram/proxy.ts).
redact_proxy() {
  printf '%s' "$1" | sed -E 's#//[^@/]+@#//#'
}

# Fails fast on a server whose network can't reach one of the two services this
# bridge depends on (firewall, geo-blocking, restrictive hosting policy). Retries a
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

# curl args for the current $TELEGRAM_PROXY (empty proxy -> direct).
build_tg_proxy_args() {
  TG_PROXY_ARGS=()
  [ -n "${TELEGRAM_PROXY:-}" ] && TG_PROXY_ARGS=(--proxy "$TELEGRAM_PROXY")
}

# One Telegram reachability check through the CURRENT $TELEGRAM_PROXY. Prints the
# verdict; returns 0/1. MAX is checked separately (always direct, by hostname so an
# IPv6-only host resolves via DNS64/NAT64 — MAX itself is IPv4-only).
check_telegram_once() {
  if [ -n "${TELEGRAM_PROXY:-}" ]; then
    if curl -sS --proxy "$TELEGRAM_PROXY" --max-time 8 -o /dev/null https://api.telegram.org 2>/dev/null; then
      echo "  Telegram (через прокси $(redact_proxy "$TELEGRAM_PROXY")): OK"
      return 0
    fi
    echo "  Telegram через прокси недоступен — возможно, неверный адрес/логин/пароль прокси."
    return 1
  fi
  if check_tcp api.telegram.org 443; then
    echo "  Telegram (api.telegram.org:443): OK"
    return 0
  fi
  echo "  Telegram напрямую недоступен (частая причина на хостингах в РФ — блокировка; помогает прокси)."
  return 1
}

# Bot API call through the current $TELEGRAM_PROXY; prints the JSON body (empty on network failure).
tg_api() {
  build_tg_proxy_args
  curl -s "${TG_PROXY_ARGS[@]}" --max-time 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/$1" || true
}

# Token: format first (catches paste errors), then getMe — proves it's a real, live token AND shows
# which bot it belongs to (a token from the wrong bot passes every format check). Before this, a bad
# token only surfaced later as a puzzling "group not found".
verify_bot_token() {
  if ! [[ "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,50}$ ]]; then
    echo "  ❌ Не похоже на токен бота (формат 123456789:AAAA…). Скопируйте его целиком из @BotFather."
    return 1
  fi
  command -v jq >/dev/null 2>&1 || { echo "  (jq не найден — проверяю только формат токена)"; return 0; }
  local me user desc
  me=$(tg_api getMe)
  user=$(echo "$me" | jq -r 'select(.ok == true) | .result.username // empty' 2>/dev/null)
  if [ -z "$user" ]; then
    desc=$(echo "$me" | jq -r '.description // empty' 2>/dev/null)
    echo "  ❌ Telegram не принял токен${desc:+ ($desc)}. Проверьте его в @BotFather (/mybots → API Token)."
    return 1
  fi
  echo "  ✅ Токен принят: это бот @${user}"
  return 0
}

# Group: must be reachable, a supergroup with Topics enabled, and the bot an admin holding
# "Manage Topics" — each missing piece is named explicitly (people used to hit a bare
# "can't create topics" much later, after the container was already up).
verify_group() {
  command -v jq >/dev/null 2>&1 || return 0
  local chat title type forum bot_id member status can ok=0
  chat=$(tg_api "getChat?chat_id=$1")
  if [ "$(echo "$chat" | jq -r '.ok' 2>/dev/null)" != "true" ]; then
    echo "  ❌ Группа $1 недоступна боту: $(echo "$chat" | jq -r '.description // "нет ответа"' 2>/dev/null). Бот добавлен в неё?"
    return 1
  fi
  title=$(echo "$chat" | jq -r '.result.title // "без названия"')
  type=$(echo "$chat" | jq -r '.result.type')
  forum=$(echo "$chat" | jq -r '.result.is_forum // false')
  echo "  Группа: «$title» ($1)"
  if [ "$type" != "supergroup" ]; then echo "  ❌ Это не супергруппа ($type) — включите Темы: настройки группы → Темы (группа станет супергруппой)."; ok=1; fi
  if [ "$forum" != "true" ]; then echo "  ❌ В группе выключены Темы — включите: настройки группы → Темы."; ok=1; fi
  bot_id="${TELEGRAM_BOT_TOKEN%%:*}"
  member=$(tg_api "getChatMember?chat_id=$1&user_id=$bot_id")
  status=$(echo "$member" | jq -r '.result.status // "unknown"')
  can=$(echo "$member" | jq -r '.result.can_manage_topics // false')
  if [ "$status" != "administrator" ] && [ "$status" != "creator" ]; then
    echo "  ❌ Бот не администратор группы (статус: $status) — сделайте его администратором."; ok=1
  elif [ "$can" != "true" ]; then
    echo "  ❌ У бота нет права «Управление темами» (Manage Topics) — включите его в правах администратора."; ok=1
  fi
  [ "$ok" -eq 0 ] && echo "  ✅ Темы включены, бот — администратор с «Управлением темами»."
  return $ok
}

# Interactive loop: keeps re-asking for a proxy until Telegram is reachable through
# the current setting (or the user types skip). Works off/into $TELEGRAM_PROXY —
# the caller decides what to do with the verified value. Telegram is NOT fatal here:
# the usual cause is a mistyped proxy — fixable right in the loop, with an explicit
# "skip" escape so a genuinely blocked host isn't a dead end.
verify_telegram_proxy_loop() {
  while true; do
    check_telegram_once && return 0
    echo "    • впишите прокси (socks5://… или http://…) и Enter — перепроверю через него;"
    echo "    • пустой Enter — перепроверить напрямую, без прокси;"
    echo "    • skip — продолжить без проверки (значение сохранится как есть)."
    read -rp "  > " TG_INPUT
    if [ "$TG_INPUT" = "skip" ]; then
      echo "  Пропускаю проверку Telegram. Без связи с Telegram пересылки не будет —"
      echo "  прокси можно поменять позже, снова запустив ./setup.sh."
      return 0
    fi
    TELEGRAM_PROXY="$TG_INPUT"
  done
}

# Detects the target Telegram group via getUpdates (needs $TELEGRAM_BOT_TOKEN and jq;
# honors $TELEGRAM_PROXY). Sets $TARGET_TELEGRAM_GROUP. Loops until found/picked.
detect_group() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "❌ Не найден jq — без него не могу определить группу. Установите: apt-get install -y jq — и запустите setup.sh заново."
    exit 1
  fi
  build_tg_proxy_args
  TARGET_TELEGRAM_GROUP=""
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
      read -rp "Сделайте это и нажмите Enter — или введите id группы вручную (вида -100…): " MANUAL_GROUP
      if [[ "${MANUAL_GROUP:-}" =~ ^-?[0-9]{5,}$ ]]; then
        TARGET_TELEGRAM_GROUP="$MANUAL_GROUP"
        verify_group "$TARGET_TELEGRAM_GROUP" || { TARGET_TELEGRAM_GROUP=""; read -rp "Исправьте и нажмите Enter, чтобы проверить снова... "; }
      fi
      continue
    fi

    mapfile -t GROUP_LINES <<< "$TG_GROUPS"
    if [ "${#GROUP_LINES[@]}" -eq 1 ]; then
      TARGET_TELEGRAM_GROUP="${GROUP_LINES[0]%%$'\t'*}"
      echo "Нашёл группу: «${GROUP_LINES[0]#*$'\t'}» ($TARGET_TELEGRAM_GROUP)"
      verify_group "$TARGET_TELEGRAM_GROUP" || { TARGET_TELEGRAM_GROUP=""; read -rp "Исправьте права/темы и нажмите Enter, чтобы проверить снова... "; }
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
          verify_group "$TARGET_TELEGRAM_GROUP" || { TARGET_TELEGRAM_GROUP=""; echo "  Исправьте и выберите группу снова."; }
        else
          echo "  Нет такого номера, попробуйте ещё раз."
        fi
      done
    fi
  done
}

# Rewrites (or appends) NAME=value in .env, preserving every other line as-is.
# awk instead of sed so proxy URLs with #, @, / etc. can't break the substitution.
set_env_var() {
  local name="$1" value="$2"
  if grep -q "^${name}=" .env 2>/dev/null; then
    awk -v n="$name" -v v="$value" 'index($0, n"=") == 1 { print n"=" v; next } { print }' .env > .env.tmp
    mv .env.tmp .env
  else
    echo "${name}=${value}" >> .env
  fi
  chmod 600 .env
}

compose_up() {
  # The container runs as the unprivileged node user (uid 1000) — the mounted ./data
  # volume must be writable by it (root-owned dirs from older installs aren't).
  mkdir -p data
  [ "$(id -u)" = "0" ] && chown -R 1000:1000 data 2>/dev/null || true
  GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown) docker compose up -d "$@"
}

# Recreate the container so an .env change actually takes effect (docker only reads
# env_file at container creation; a plain restart keeps the old values).
apply_env_change() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker недоступен — изменения сохранены в .env, примените их там, где запущен контейнер."
    return 0
  fi
  read -rp "Пересоздать контейнер, чтобы применить изменения? [Y/n] " APPLY_NOW
  if [ "${APPLY_NOW:-Y}" = "n" ] || [ "${APPLY_NOW:-Y}" = "N" ]; then
    echo "Ок. Применится при следующем: docker compose up -d --force-recreate"
    return 0
  fi
  compose_up --force-recreate
  echo "✅ Применено."
}

# ---------------------------------------------------------------------------
# Settings menu — .env already exists, so this is a configured install.
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  # Old installs (pre-0.3) left .env world-readable — tighten on every run.
  chmod 600 .env

  show_status() {
    # Re-read on every call so the menu always shows what's actually in .env.
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
    local container="не запущен"
    if command -v docker >/dev/null 2>&1 && [ -n "$(docker compose ps --status running --format '{{.Name}}' 2>/dev/null)" ]; then
      container="работает"
    fi
    echo
    bold "=== Telemax — текущие настройки ==="
    echo "  Контейнер:        $container"
    echo "  Токен бота:       $(mask_token "${TELEGRAM_BOT_TOKEN:-}")"
    echo "  Группа Telegram:  ${TARGET_TELEGRAM_GROUP:-не задана}"
    if [ -n "${TELEGRAM_PROXY:-}" ]; then
      echo "  Прокси Telegram:  $(redact_proxy "$TELEGRAM_PROXY")"
    else
      echo "  Прокси Telegram:  нет (напрямую)"
    fi
    echo "  Стикеры (образ):  ${STICKERS:-full}"
    echo "  MAX-авторизация:  через бота — /login в личку (статус виден в /panel)"
  }

  change_proxy() {
    echo
    if [ -n "${TELEGRAM_PROXY:-}" ]; then
      echo "Текущий прокси: $(redact_proxy "$TELEGRAM_PROXY")"
    else
      echo "Сейчас прокси не задан — Telegram идёт напрямую."
    fi
    echo "Форматы: socks5://[логин:пароль@]хост:порт или http://[логин:пароль@]хост:порт."
    echo "Введите новый адрес; «-» — убрать прокси (напрямую); пустой Enter — оставить как есть."
    read -rp "Прокси: " NEW_PROXY
    case "$NEW_PROXY" in
      '') echo "Оставляю как есть."; return 0 ;;
      -) TELEGRAM_PROXY="" ;;
      *) TELEGRAM_PROXY="$NEW_PROXY" ;;
    esac
    echo "Проверяю связь с Telegram через новую настройку..."
    verify_telegram_proxy_loop
    set_env_var TELEGRAM_PROXY "$TELEGRAM_PROXY"
    echo "Сохранено в .env: TELEGRAM_PROXY=$( [ -n "$TELEGRAM_PROXY" ] && redact_proxy "$TELEGRAM_PROXY" || echo '(напрямую)' )"
    apply_env_change
  }

  change_bot() {
    echo
    echo "Текущий токен: $(mask_token "${TELEGRAM_BOT_TOKEN:-}")"
    read -rp "Новый токен бота (пустой Enter — оставить текущий): " NEW_TOKEN
    local token_changed=0
    if [ -n "$NEW_TOKEN" ]; then
      TELEGRAM_BOT_TOKEN="$NEW_TOKEN"
      token_changed=1
    fi
    echo "Текущая группа: ${TARGET_TELEGRAM_GROUP:-не задана}"
    local redetect="n"
    if [ "$token_changed" = "1" ]; then
      # A new bot almost certainly means the group binding needs re-checking too.
      read -rp "Определить группу заново? [Y/n] " R
      [ "${R:-Y}" != "n" ] && [ "${R:-Y}" != "N" ] && redetect="y"
    else
      read -rp "Определить группу заново? [y/N] " R
      { [ "${R:-N}" = "y" ] || [ "${R:-N}" = "Y" ]; } && redetect="y"
    fi
    if [ "$redetect" = "y" ]; then
      echo "Добавьте бота в нужную группу администратором (право «Управление темами») и напишите в неё любое сообщение."
      read -rp "Готово? Enter... "
      detect_group
    fi
    [ "$token_changed" = "1" ] && set_env_var TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
    set_env_var TARGET_TELEGRAM_GROUP "$TARGET_TELEGRAM_GROUP"
    echo "Сохранено."
    apply_env_change
  }

  change_stickers() {
    echo
    local current="${STICKERS:-full}"
    echo "Сейчас: $current."
    echo "  • full — анимированные стикеры проигрываются как видео (образ +~1.4 ГБ, сборка дольше)."
    echo "  • slim — уходят статической картинкой (образ ~0.3 ГБ, быстрая сборка)."
    local target="slim"
    [ "$current" = "slim" ] && target="full"
    read -rp "Переключить на $target и пересобрать образ? [y/N] " SW
    if [ "${SW:-N}" != "y" ] && [ "${SW:-N}" != "Y" ]; then
      echo "Оставляю $current."
      return 0
    fi
    set_env_var STICKERS "$target"
    if command -v docker >/dev/null 2>&1; then
      echo "Пересобираю образ ($target)..."
      compose_up --build
      echo "✅ Готово."
    else
      echo "Docker недоступен — сохранено в .env, пересоберите там, где запущен контейнер."
    fi
  }

  check_connectivity() {
    echo
    echo "Проверяю связь..."
    if check_tcp api2.oneme.ru 443; then
      echo "  MAX (api2.oneme.ru:443): OK"
    else
      echo "  MAX (api2.oneme.ru:443): нет связи — мост работать не сможет (файрвол/гео-блокировка;"
      echo "  на IPv6-only хосте нужен NAT64/DNS64 у провайдера)."
    fi
    check_telegram_once || true
  }

  # Make current .env values available to the menu handlers.
  show_status
  while true; do
    echo
    bold "Что сделать?"
    echo "  1) Показать текущие настройки"
    echo "  2) Изменить прокси Telegram (с проверкой связи до записи)"
    echo "  3) Сменить токен бота / группу"
    echo "  4) Переключить режим стикеров (full/slim, с пересборкой)"
    echo "  5) Проверить связь с MAX и Telegram"
    echo "  6) Пересобрать и перезапустить контейнер"
    echo "  0) Выход"
    read -rp "Пункт: " MENU_CHOICE
    case "$MENU_CHOICE" in
      1) show_status ;;
      2) change_proxy ;;
      3) change_bot ;;
      4) change_stickers ;;
      5) check_connectivity ;;
      6)
        if command -v docker >/dev/null 2>&1; then
          compose_up --build
          echo "✅ Пересобрано и запущено."
        else
          echo "Docker недоступен на этой машине."
        fi
        ;;
      0 | '')
        echo "Если MAX ещё не авторизован — напишите боту в ЛИЧКУ: /login (или в группе: /panel → «🔐 Вход в MAX»)."
        exit 0
        ;;
      *) echo "Нет такого пункта." ;;
    esac
  done
fi

# ---------------------------------------------------------------------------
# First-time setup — no .env yet.
# ---------------------------------------------------------------------------

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
# proxy at all) — both fixable right in the loop (see verify_telegram_proxy_loop).
verify_telegram_proxy_loop

echo
echo "Понадобится токен бота — создайте его через @BotFather (https://t.me/BotFather), команда /newbot."
echo

read -rp "Токен бота (TELEGRAM_BOT_TOKEN): " TELEGRAM_BOT_TOKEN
until [ -n "$TELEGRAM_BOT_TOKEN" ] && verify_bot_token; do
  read -rp "Токен бота (TELEGRAM_BOT_TOKEN): " TELEGRAM_BOT_TOKEN
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

read -rp "Сделали? Нажмите Enter, когда бот добавлен в группу администратором... "
detect_group

# Best-effort — needs the bot to already be a group admin with "Change Group
# Info" rights, which setup already asked for above. setChatPhoto needs an
# actual file upload (multipart), not a URL, unlike sendPhoto.
build_tg_proxy_args
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
compose_up --build

echo
echo "════════════════════════════════════════════════════════════════"
bold "  ✅ Мост собран и запущен. Остался ОДИН обязательный шаг: авторизация MAX."
echo "  Откройте вашего бота в Telegram и напишите ему в ЛИЧКУ команду:"
bold "      /login"
echo "  Введёте номер MAX и код из SMS прямо в личке — в группу они не попадут."
echo "  (Альтернатива: в группе /panel → «🔐 Вход в MAX».)"
echo "════════════════════════════════════════════════════════════════"
echo
echo "Изменить настройки позже (прокси, токен, группа, стикеры) — просто запустите ./setup.sh ещё раз."
