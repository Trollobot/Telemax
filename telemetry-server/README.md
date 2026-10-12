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

## Landing visits (`site.mjs`)

The landing (`docs/` → telemax.svnest.ru and its GitHub Pages copy) sends a beacon on every open; the
public page `/stats/` shows the result. Caddy on the monitoring host routes `https://telemax.svnest.ru/api/site/*`
here with the `/api` prefix stripped.

- `POST /site/hit` — `{"r": document.referrer, "h": location.hostname}` as `text/plain` (no CORS preflight).
  Returns 204. Bots (by user agent) are skipped; 120 beacons per IP per hour.
- `GET /site/stats` — public aggregates for the last 30 days plus totals: views, daily unique visitors,
  hours (Moscow time), countries, sources (Хабр, vc.ru, GitHub, Telegram, search engines, direct), and
  which copy of the site was opened. **Visits only** — installs and reports stay behind `STATS_KEY`.

Privacy: nothing about a visitor reaches the disk. The beacon is folded into per-day counters at once;
unique visitors are a per-day set of salted hashes kept in memory with a salt that is replaced every
Moscow day, so `data/site.json` holds numbers only. Countries come from the free DB-IP «IP to Country
Lite» table (CC BY 4.0 — the `/stats/` page credits it), which the server downloads into
`data/dbip-country-lite.csv.gz` on start and refreshes monthly; until it loads, countries read «??».

## MAX desktop version watch (`maxversion.mjs`)

MAX refuses logins from a client it considers outdated («Приложение устарело, пожалуйста, обновитесь»),
and the bridge presents itself as MAX desktop with `DEFAULT_APP_VERSION` / `DEFAULT_BUILD_NUMBER` from
`src/max/client.ts`. Every 6 hours (and a minute after start) the server reads MAX's apt repo
(`download.max.ru/linux/deb/…/Packages`: the newest «Version:» and the build in «MAX-<version>.<build>.deb»)
and the bridge's numbers from `src/max/client.ts` on GitHub `main`, so it follows every release by itself.
When MAX is ahead it posts ONE notice per new MAX version to the maintainer's «🤖 Автоотчёты об ошибках»
topic, with the numbers to release (and the `.env` override users can apply meanwhile). State, including
the last announced version, is kept in `data/maxversion.json`; if GitHub is unreachable it compares with the
bridge numbers it read last time.
