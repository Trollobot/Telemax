FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Baked in from the host's git checkout at build time (docker-compose.yml passes
# it through from $GIT_COMMIT) — the runtime image has no .git of its own
# (excluded via .dockerignore), so this is the only way /version can know what
# commit is actually running vs what's latest on GitHub.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
# Animated-sticker rendering (.tgs/Lottie → short WebM via headless Chromium + ffmpeg, so it can go
# through the ordinary VIDEO_UPLOAD pipeline and autoplay in the feed like MAX's own animated stickers)
# is OPTIONAL — chromium + ffmpeg together weigh ~1.4 GB. Build with --build-arg STICKERS=slim to skip
# them (image ~0.3 GB); animated stickers then relay as their static thumbnail instead of a playable
# video. STICKERS=full (default) installs them. ca-certificates is always needed for TLS.
ARG STICKERS=full
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && if [ "$STICKERS" = "full" ]; then apt-get install -y --no-install-recommends chromium ffmpeg; fi \
    && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
# MAX's TLS chain goes through Russia's state CA (Минцифры "Russian Trusted
# Root/Sub CA"), which no standard trust store includes. Deliberately NOT
# installed system-wide (update-ca-certificates) or process-wide
# (NODE_EXTRA_CA_CERTS) anymore — that made every TLS connection from this
# container (Telegram Bot API, GitHub) trust the state CA too, i.e. exactly the
# MITM exposure such a CA enables. src/max/ca.ts scopes the trust to MAX
# connections only, reading these PEMs at runtime; see certs/README.md for how
# the chain was verified.
COPY certs ./certs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY entrypoint.sh ./
# Privilege drop lives in entrypoint.sh, not a static `USER node`: the entrypoint
# must start as root once per boot to chown the mounted ./data (root-owned on every
# pre-0.4.9 install) before handing off to the unprivileged node user — see the
# script for the full rationale. sh -form so the script needs no exec bit (Windows
# checkouts drop it); exec-chain keeps node as PID 1 for SIGTERM.
# Headless bridge (v0.4): no inbound web server — MAX is an outbound socket, Telegram is long-polled.
CMD ["/bin/sh", "/app/entrypoint.sh"]
