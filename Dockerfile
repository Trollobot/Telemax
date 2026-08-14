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
# node:22-slim ships without a CA bundle, so MaxClient's TLS verification
# (rejectUnauthorized: true, on by default) fails with "unable to get local
# issuer certificate" — confirmed live on first deploy 2026-08-08. MAX's cert
# chains up through Russia's state CA (Минцифры "Russian Trusted Root/Sub CA"),
# which isn't in any standard public trust store, so the public ca-certificates
# package alone isn't enough — this specific chain has to be added too. Verified
# subject/issuer fields against the actual chain MAX presents before trusting it
# (see certs/README.md) — these are the well-known official gosuslugi.ru files.
# chromium + ffmpeg: rendering Telegram's animated (.tgs/Lottie) stickers to a
# short WebM so they can go through the ordinary VIDEO_UPLOAD pipeline — MAX has
# no confirmed native sticker-upload opcode, but its own animated stickers arrive
# as autoplaying VIDEO attaches, so this gets the same "plays in the feed" result.
# Uses puppeteer-core (no bundled Chromium download) against this system package
# instead, keeping the image smaller.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
COPY certs/russian_trusted_root_ca.crt /usr/local/share/ca-certificates/russian_trusted_root_ca.crt
COPY certs/russian_trusted_sub_ca.crt /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt
RUN update-ca-certificates
# Node.js ignores the OS trust store by default (it ships its own bundled Mozilla
# CA list) — update-ca-certificates above is necessary but not sufficient. This is
# the actual mechanism Node uses to trust anything beyond its bundled list.
RUN (cat /usr/local/share/ca-certificates/russian_trusted_root_ca.crt; echo; cat /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt) > /usr/local/share/ca-certificates/russian-trusted-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian-trusted-bundle.pem
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.mjs"]
