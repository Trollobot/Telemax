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
# chromium + ffmpeg: rendering Telegram's animated (.tgs/Lottie) stickers to a
# short WebM so they can go through the ordinary VIDEO_UPLOAD pipeline — MAX has
# no confirmed native sticker-upload opcode, but its own animated stickers arrive
# as autoplaying VIDEO attaches, so this gets the same "plays in the feed" result.
# Uses puppeteer-core (no bundled Chromium download) against this system package
# instead, keeping the image smaller.
# openssl: generates the web panel's self-signed TLS certificate on first start
# (see loadOrCreatePanelCert in src/server/app.ts).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg openssl && rm -rf /var/lib/apt/lists/*
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
EXPOSE 3000
CMD ["node", "dist/server.mjs"]
