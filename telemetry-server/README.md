# Telemax telemetry server (maintainer-only)

Anonymous install counter. **Not part of a normal Telemax deployment** — this runs only on the
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
