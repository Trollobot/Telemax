# Telemax telemetry server (maintainer-only)

Anonymous install counter and error-report collector. **Not part of a normal Telemax deployment** — this runs only on the
maintainer's monitoring host, which the client's DDNS hostname (`zergont-gate.duckdns.org`)
points at. The bot client lives in `src/bridge/telemetry.ts` and posts here once a day.

Stores `installId -> { firstSeen, lastSeen, version }` in `./data/installs.json`. No IPs, no
personal data.

## Run

```bash
cd telemetry-server
echo "STATS_KEY=$(head -c24 /dev/urandom | base64 | tr -d '/+=')" > .env   # secret to read /stats
docker compose up -d --build
```

Listens on `:3100`. Make sure the host firewall allows inbound TCP 3100.

## Endpoints

- `POST /ping` — `{ installId, version, ts }` from installs. Returns 204. (No key — anonymous.)
- `GET /stats?days=30` with header `X-Stats-Key: <STATS_KEY>` — live-install count + version
  breakdown. **HTTPS only**: it must come through the TLS reverse proxy in front of the server
  (which sets `X-Forwarded-Proto: https`); a request straight to plain-HTTP `:3100` gets 403.
  `?key=<STATS_KEY>` still works instead of the header, but the header keeps the key out of
  access logs. `byVersion` keys are the bridge's `package.json` version (semver):

```json
{ "totalEver": 42, "activeInWindow": 37, "windowDays": 30, "byVersion": { "1.0.1": 30, "1.0.0": 7 } }
```

Read it any time:

```bash
curl -H "X-Stats-Key: <STATS_KEY>" "https://zergont-gate.duckdns.org/stats?days=30"
```

## Error reports

- `POST /report` — `{ installId, version, kind, step?, error?, toVersion?, freeMb?, memMb?, os?,
  docker?, git?, node? }` from the bridge (`reportError` in `src/bridge/telemetry.ts`) and from
  `update.sh` (`report_failure`). Always 204. A report counts only when its `installId` has
  already pinged (there is no shared secret — the code is open source), within 10 reports per
  install per 24 h and 30 per IP per hour; strings are truncated (error 300, others 60).
- Reports are aggregated by signature = kind | step | normalized error (numbers, hex ids and
  directories removed) into `./data/reports.json` (at most 2000 signatures): count, first/last
  seen, distinct installs, versions, the first raw error as the sample.
- `GET /reports?days=30` — same guard as `/stats`; the list sorted by last seen.

```bash
curl -H "X-Stats-Key: <STATS_KEY>" "https://zergont-gate.duckdns.org/reports?days=30"
```

### Telegram notifications

Optional, in `.env` (then `docker compose up -d`):

```bash
REPORT_BOT_TOKEN=123456:ABC...   # a bot that is a member of the chat
REPORT_CHAT_ID=-1001234567890
REPORT_THREAD_ID=42              # optional forum topic
```

Without `REPORT_THREAD_ID` the server creates one topic «🤖 Автоотчёты об ошибках» on first use
(the bot needs the right to manage topics) and remembers it in `reports.json`; if that fails the
message goes to the chat itself. A signature is announced once, when first seen, and at most one
message is sent per hour — further new signatures are folded into the next one. The message never
contains an installId.
