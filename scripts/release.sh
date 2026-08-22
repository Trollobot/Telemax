#!/usr/bin/env bash
# Maintainer-only release ritual. Run from a full clone AFTER bumping package.json's version and
# creating the matching tag (git tag vX.Y.Z). It pushes main + tags to BOTH GitHub (origin) and the
# self-hosted fallback mirror, then refreshes the mirror's latest.json so installs that CAN'T reach
# GitHub (account flagged, or GitHub filtered on their network) still learn about the new version
# and can update from the mirror. See src/bridge/version.ts (checkVersion fallback) and update.sh
# (git pull fallback) for the consuming side.
#
# NOT part of a normal deployment — installs never run this.
#
#   Usage:  ./scripts/release.sh
#   Env:    MIRROR_SSH (default root@zergont-gate.duckdns.org)
#           MIRROR_REPO_PATH (default /opt/telemax-mirror/web/Telemax.git)
#           MIRROR_WEB_PATH  (default /opt/telemax-mirror/web)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

MIRROR_SSH="${MIRROR_SSH:-root@zergont-gate.duckdns.org}"
MIRROR_REPO_PATH="${MIRROR_REPO_PATH:-/opt/telemax-mirror/web/Telemax.git}"
MIRROR_WEB_PATH="${MIRROR_WEB_PATH:-/opt/telemax-mirror/web}"
MIRROR_GIT_URL="ssh://${MIRROR_SSH}${MIRROR_REPO_PATH}"
# Public HTTP base of the mirror — used to read back the current latest.json so the per-version
# changelog map accumulates across releases (see scripts/build-latest-json.mjs).
MIRROR_HTTP_URL="${MIRROR_HTTP_URL:-http://zergont-gate.duckdns.org:3200}"

echo ">> Releasing ${TAG}"

# The tag must already exist (coordinate the tag first, then run this).
if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "!! Tag ${TAG} not found. Create it first:  git tag -s ${TAG}  then re-run." >&2
  exit 1
fi

# Signed-release trust (v0.4): once the maintainer's key is pinned in the repo (allowed_signers),
# refuse to publish a tag that isn't validly SSH-signed by it — so neither GitHub nor the mirror can
# ever carry code that update.sh's verify-tag would (correctly) reject. Sign tags with the neutral
# release identity so no personal email leaks into public history:
#   git -c gpg.format=ssh -c user.signingkey=~/.ssh/id_ed25519.pub \
#       -c user.name='Telemax Release' -c user.email=release@telemax tag -s vX.Y.Z -m vX.Y.Z
if [ -f allowed_signers ]; then
  if ! git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=allowed_signers verify-tag "${TAG}" >/dev/null 2>&1; then
    echo "!! Tag ${TAG} is not validly signed by the pinned release key (see the git tag -s line above)." >&2
    exit 1
  fi
  echo ">> release signature OK (ssh): ${TAG}"
fi

echo ">> [1/4] push to GitHub (origin)"
git push origin main
git push origin "${TAG}"

echo ">> [2/4] push to mirror (${MIRROR_GIT_URL})"
git push "${MIRROR_GIT_URL}" "+refs/heads/main:refs/heads/main" "+refs/tags/*:refs/tags/*"

echo ">> [3/4] build latest.json (cumulative per-version changelog)"
PREV_TAG=$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || echo "")
RANGE="${TAG}"
[ -n "${PREV_TAG}" ] && RANGE="${PREV_TAG}..${TAG}"
# This version's notes: commit subjects since the previous tag, minus the release-bump commit itself.
NEW_NOTES_JSON=$(git log --format='%s' "${RANGE}" | grep -viE '^Релиз |^Release ' \
  | node -e "const l=require('fs').readFileSync(0,'utf8').split('\n').filter(Boolean); process.stdout.write(JSON.stringify(l))")
# Accumulate into the map already published on the mirror so multi-version jumps keep every release.
EXISTING_JSON=$(curl -fsS "${MIRROR_HTTP_URL}/latest.json" 2>/dev/null || echo '{}')
LATEST_JSON=$(node scripts/build-latest-json.mjs "${VERSION}" "${TAG}" "${NEW_NOTES_JSON}" "${EXISTING_JSON}")
echo "   ${LATEST_JSON}"

echo ">> [4/4] upload latest.json + install.sh to mirror + refresh dumb-http index"
ssh "${MIRROR_SSH}" "cat > ${MIRROR_WEB_PATH}/latest.json" <<<"${LATEST_JSON}"
# Serve the bootstrap script from the mirror too, so a fresh install works while GitHub is down:
#   curl -fsSL http://<mirror>/install.sh | bash
scp -q install.sh "${MIRROR_SSH}:${MIRROR_WEB_PATH}/install.sh"
ssh "${MIRROR_SSH}" "cd ${MIRROR_REPO_PATH} && git update-server-info"

echo ">> Done. Released ${TAG} to GitHub + mirror."
