#!/usr/bin/env bash
# Starts or stops the shared Telemax files service (Caddy + files-service/server.mjs) — ONE per
# host for every bridge in /etc/telemax/instances. Called every minute by update-watcher.sh, i.e.
# by the root update dispatcher, so installs get it with a normal update (no setup.sh re-run).
#
# Ports 80/443 are open ONLY while some bridge has a live big-file link: each bridge keeps
# `data/files/active` while it has one (src/bridge/fileShare.ts). No marker anywhere → the service
# is stopped. The result goes back to every bridge as `data/files/service.json`.
#
# TLS without a domain: Let's Encrypt issues short-lived (~6-day) certificates for a bare IP
# (generally available since 2026-01; Caddy needs the `shortlived` profile and `default_sni`,
# because browsers send no SNI for an IP). FILES_DOMAIN in the first bridge's .env uses a domain
# instead. Caddy keeps its certificate in /var/lib/telemax-files/caddy-data between runs.
set -uo pipefail

REG=/etc/telemax/instances
STATE_DIR=/var/lib/telemax-files
PROJECT=telemax-files
CADDY_IMAGE='caddy:2.11.7@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772'
SELF="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$REG" ] || exit 0
[ "$(id -u)" = "0" ] || exit 0
command -v docker >/dev/null 2>&1 || exit 0

# One owner: the first registered install that ships this script. Every bridge's watcher calls us
# each minute; without a single owner two installs on different versions would flip-flop the config.
LEADER=""
while IFS= read -r d; do
  [ -n "$d" ] && [ -f "$d/files-service/reconcile.sh" ] && { LEADER="$d"; break; }
done < "$REG"
[ "$LEADER" = "$SELF" ] || exit 0

mkdir -p "$STATE_DIR"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATE_DIR/reconcile.log"; tail -n 200 "$STATE_DIR/reconcile.log" > "$STATE_DIR/reconcile.log.tmp" 2>/dev/null && mv "$STATE_DIR/reconcile.log.tmp" "$STATE_DIR/reconcile.log"; }
env_value() { grep -E "^$2=" "$1/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' \r"; }

INSTANCES=()
WANTED=0
while IFS= read -r d; do
  [ -n "$d" ] && [ -d "$d/data/files" ] || continue
  case "$(env_value "$d" FILES | tr '[:upper:]' '[:lower:]')" in 0|false|off|no) continue ;; esac
  INSTANCES+=("$d")
  [ -f "$d/data/files/active" ] && WANTED=1
done < "$REG"

write_state() { # state url detail
  local now detail
  now=$(date +%s)
  detail=$(printf '%s' "$3" | tr -d '"\\\n\r' | cut -c1-200)
  for d in "${INSTANCES[@]}"; do
    printf '{"state":"%s","url":"%s","at":%s,"detail":"%s"}\n' "$1" "$2" "$now" "$detail" > "$d/data/files/service.json.tmp" \
      && chmod 644 "$d/data/files/service.json.tmp" && mv -f "$d/data/files/service.json.tmp" "$d/data/files/service.json"
  done
}

running() { docker ps -q --filter "label=com.docker.compose.project=$PROJECT" | grep -q .; }
compose() { docker compose -p "$PROJECT" -f "$STATE_DIR/compose.yml" "$@"; }

if [ "$WANTED" = 0 ]; then
  if running; then
    compose down >/dev/null 2>&1 && log "no live links — service stopped$([ -n "$(env_value "$LEADER" FILES_LISTEN)" ] && echo "" || echo ", ports 80/443 closed")"
  fi
  rm -f "$STATE_DIR/starting-since"
  write_state down "" ""
  exit 0
fi

# --- behind a web server the host already runs (FILES_PUBLIC_URL + FILES_LISTEN) ----------------
# When 80/443 belong to an existing Caddy/nginx, no Caddy of ours: the app listens on a local port
# only and that server routes a path or a name to it, e.g. for Caddy:
#   handle_path /tlmx-files/* { reverse_proxy 127.0.0.1:3300 }
# with FILES_PUBLIC_URL=https://example.org/tlmx-files and FILES_LISTEN=127.0.0.1:3300.
PUBLIC_URL=$(env_value "$LEADER" FILES_PUBLIC_URL)
PUBLIC_URL="${PUBLIC_URL%/}"
LISTEN=$(env_value "$LEADER" FILES_LISTEN)
EXTERNAL=0
if [ -n "$PUBLIC_URL" ] && [ -n "$LISTEN" ]; then
  EXTERNAL=1
fi

# --- where the links point (own Caddy only) -----------------------------------------------------
is_public_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]}
  [ "$a" = 10 ] || [ "$a" = 127 ] || [ "$a" = 0 ] && return 1
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 1
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 1
  [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 1
  [ "$a" = 169 ] && [ "$b" = 254 ] && return 1
  return 0
}
IS_IP=0
if [ "$EXTERNAL" = 1 ]; then
  BASE_URL="$PUBLIC_URL"
else
  DOMAIN=$(env_value "$LEADER" FILES_DOMAIN)
  if [ -n "$DOMAIN" ]; then
    HOST="$DOMAIN"
  else
    IS_IP=1
    HOST=""
    # Cached for a day: the lookup is the only outside request this script makes.
    if [ -f "$STATE_DIR/public-ip" ] && [ -n "$(find "$STATE_DIR/public-ip" -mmin -1440 2>/dev/null)" ]; then
      HOST=$(cat "$STATE_DIR/public-ip")
    fi
    if ! is_public_ipv4 "$HOST"; then
      HOST=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}' | head -1)
      is_public_ipv4 "$HOST" || HOST=$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)
      is_public_ipv4 "$HOST" || HOST=$(curl -4 -fsS --max-time 6 https://ifconfig.me/ip 2>/dev/null || true)
      is_public_ipv4 "$HOST" && printf '%s\n' "$HOST" > "$STATE_DIR/public-ip"
    fi
    if ! is_public_ipv4 "$HOST"; then
      log "no public IPv4 found"
      write_state no-ip "" ""
      exit 0
    fi
  fi
  BASE_URL="https://$HOST"
  # Someone else's web server must not be fought with (see FILES_PUBLIC_URL above for sharing it).
  if ! running && ss -ltnH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -q .; then
    log "ports 80/443 are taken by another service"
    write_state ports-busy "" ""
    exit 0
  fi
fi

# --- config -------------------------------------------------------------------------------------
NODE_IMAGE=$(sed -n 's/^FROM \(node:[^ ]*\).*/\1/p' "$LEADER/Dockerfile" | head -1)
[ -n "$NODE_IMAGE" ] || NODE_IMAGE=node:22-slim
TZ_VALUE=$(env_value "$LEADER" TZ)

if [ "$EXTERNAL" = 0 ]; then
  {
    echo "{"
    echo "	admin off"
    if [ "$IS_IP" = 1 ]; then
      echo "	default_sni $HOST"
      echo "	cert_issuer acme {"
      echo "		profile shortlived"
      echo "	}"
    fi
    echo "}"
    echo "https://$HOST {"
    echo "	reverse_proxy app:8080"
    echo "}"
  } > "$STATE_DIR/Caddyfile.new"
fi

{
  echo "name: $PROJECT"
  echo "services:"
  if [ "$EXTERNAL" = 0 ]; then
    echo "  caddy:"
    echo "    image: $CADDY_IMAGE"
    echo "    restart: unless-stopped"
    echo "    ports: [\"80:80\", \"443:443\"]"
    echo "    volumes:"
    echo "      - $STATE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro"
    echo "      - $STATE_DIR/caddy-data:/data"
    echo "      - $STATE_DIR/caddy-config:/config"
    echo "    depends_on: [app]"
    echo "    logging: {driver: json-file, options: {max-size: \"5m\", max-file: \"2\"}}"
  fi
  echo "  app:"
  echo "    image: $NODE_IMAGE"
  echo "    restart: unless-stopped"
  echo "    user: \"1000:1000\""
  echo "    command: [\"node\", \"/svc/server.mjs\"]"
  [ "$EXTERNAL" = 1 ] && echo "    ports: [\"$LISTEN:8080\"]"
  echo "    environment:"
  echo "      TZ: \"${TZ_VALUE:-Europe/Moscow}\""
  echo "    volumes:"
  echo "      - $LEADER/files-service:/svc:ro"
  i=0
  for d in "${INSTANCES[@]}"; do
    i=$((i + 1))
    echo "      - $d/data/files:/srv/$i"
  done
  echo "    logging: {driver: json-file, options: {max-size: \"5m\", max-file: \"2\"}}"
} > "$STATE_DIR/compose.yml.new"

CADDY_CHANGED=0
if [ "$EXTERNAL" = 0 ]; then
  cmp -s "$STATE_DIR/Caddyfile.new" "$STATE_DIR/Caddyfile" 2>/dev/null || CADDY_CHANGED=1
  mv -f "$STATE_DIR/Caddyfile.new" "$STATE_DIR/Caddyfile"
fi
mv -f "$STATE_DIR/compose.yml.new" "$STATE_DIR/compose.yml"

WAS_RUNNING=0
running && WAS_RUNNING=1
if ! compose up -d --remove-orphans >"$STATE_DIR/compose-up.log" 2>&1; then
  log "compose up failed: $(tail -n 3 "$STATE_DIR/compose-up.log" | tr '\n' ' ')"
  write_state error "" "$(grep -iE 'error|bind|address already' "$STATE_DIR/compose-up.log" | tail -1)"
  exit 0
fi
if [ "$WAS_RUNNING" = 0 ]; then
  if [ "$EXTERNAL" = 1 ]; then log "live links — service started on $LISTEN behind $BASE_URL"
  else log "live links — service started for $BASE_URL, ports 80/443 open"; fi
fi
[ "$WAS_RUNNING" = 1 ] && [ "$CADDY_CHANGED" = 1 ] && compose restart caddy >/dev/null 2>&1
# server.mjs is mounted, not baked in: after an update brings a new one, restart the app to load it.
APP_SUM=$(sha256sum "$LEADER/files-service/server.mjs" 2>/dev/null | cut -c1-64)
if [ "$WAS_RUNNING" = 1 ] && [ -n "$APP_SUM" ] && [ "$APP_SUM" != "$(cat "$STATE_DIR/app.sum" 2>/dev/null)" ]; then
  compose restart app >/dev/null 2>&1 && log "files service app restarted with the updated server.mjs"
fi
[ -n "$APP_SUM" ] && printf '%s\n' "$APP_SUM" > "$STATE_DIR/app.sum"

# --- healthy? -----------------------------------------------------------------------------------
# A fresh start needs a few seconds (and a certificate on the very first run): wait a little here
# rather than make the waiting bridge sit through another dispatcher minute.
healthy() { curl -fsS --max-time 8 "$BASE_URL/health" >/dev/null 2>&1; }
if [ "$WAS_RUNNING" = 0 ]; then
  for _ in 1 2 3 4 5 6 7 8; do healthy && break; sleep 4; done
fi
if healthy; then
  rm -f "$STATE_DIR/starting-since"
  write_state up "$BASE_URL" ""
  exit 0
fi
[ -f "$STATE_DIR/starting-since" ] || date +%s > "$STATE_DIR/starting-since"
SINCE=$(cat "$STATE_DIR/starting-since" 2>/dev/null || date +%s)
if [ $(( $(date +%s) - SINCE )) -gt 240 ]; then
  if [ "$EXTERNAL" = 1 ]; then
    WHY="$BASE_URL/health не отвечает — проверьте маршрут на $LISTEN в своём веб-сервере"
  else
    WHY=$(docker logs --tail 50 "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=caddy" | head -1)" 2>&1 \
      | grep -oE '"(error|msg)":"[^"]*"' | grep -iE 'error|fail|challenge|refused|timeout' | tail -1)
  fi
  log "not healthy after 4 min: $WHY"
  write_state error "" "HTTPS не отвечает: ${WHY:-нет подробностей}"
else
  write_state starting "" ""
fi
exit 0
