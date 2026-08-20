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
#   Env:    MIRROR_SSH (default root@46.8.238.57)
#           MIRROR_REPO_PATH (default /opt/telemax-mirror/web/Telemax.git)
#           MIRROR_WEB_PATH  (default /opt/telemax-mirror/web)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

MIRROR_SSH="${MIRROR_SSH:-root@46.8.238.57}"
MIRROR_REPO_PATH="${MIRROR_REPO_PATH:-/opt/telemax-mirror/web/Telemax.git}"
MIRROR_WEB_PATH="${MIRROR_WEB_PATH:-/opt/telemax-mirror/web}"
MIRROR_GIT_URL="ssh://${MIRROR_SSH}${MIRROR_REPO_PATH}"

echo ">> Releasing ${TAG}"

# The tag must already exist (coordinate the tag first, then run this).
if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "!! Tag ${TAG} not found. Create it first:  git tag ${TAG}  then re-run." >&2
  exit 1
fi

echo ">> [1/4] push to GitHub (origin)"
git push origin main
git push origin "${TAG}"

echo ">> [2/4] push to mirror (${MIRROR_GIT_URL})"
git push "${MIRROR_GIT_URL}" "+refs/heads/main:refs/heads/main" "+refs/tags/*:refs/tags/*"

echo ">> [3/4] build latest.json (changelog since previous tag, newest-first)"
PREV_TAG=$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || echo "")
RANGE="${TAG}"
[ -n "${PREV_TAG}" ] && RANGE="${PREV_TAG}..${TAG}"
CHANGELOG_JSON=$(git log --format='%s' "${RANGE}" \
  | node -e "const l=require('fs').readFileSync(0,'utf8').split('\n').filter(Boolean); process.stdout.write(JSON.stringify(l))")
LATEST_JSON=$(node -e "process.stdout.write(JSON.stringify({tag:process.argv[1],version:process.argv[2],changelog:JSON.parse(process.argv[3])}))" \
  "${TAG}" "${VERSION}" "${CHANGELOG_JSON}")
echo "   ${LATEST_JSON}"

echo ">> [4/4] upload latest.json + install.sh to mirror + refresh dumb-http index"
ssh "${MIRROR_SSH}" "cat > ${MIRROR_WEB_PATH}/latest.json" <<<"${LATEST_JSON}"
# Serve the bootstrap script from the mirror too, so a fresh install works while GitHub is down:
#   curl -fsSL http://<mirror>/install.sh | bash
scp -q install.sh "${MIRROR_SSH}:${MIRROR_WEB_PATH}/install.sh"
ssh "${MIRROR_SSH}" "cd ${MIRROR_REPO_PATH} && git update-server-info"

echo ">> Done. Released ${TAG} to GitHub + mirror."
