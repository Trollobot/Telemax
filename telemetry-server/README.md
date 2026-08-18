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
- `GET /stats?key=<STATS_KEY>&days=30` — live-install count + version breakdown:

```json
{ "totalEver": 42, "activeInWindow": 37, "windowDays": 30, "byVersion": { "46d2793": 30, "b23c4fb": 7 } }
```

Read it any time:

```bash
curl "http://zergont-gate.duckdns.org:3100/stats?key=<STATS_KEY>&days=30"
```
