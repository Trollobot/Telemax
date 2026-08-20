// Builds the mirror's latest.json for a release, ACCUMULATING a per-version changelog map so an
// install several versions behind still sees every skipped version's notes (the GitHub compare API
// does this dynamically; the static mirror needs the map — see version.ts assembleMirrorChangelog).
//
//   node scripts/build-latest-json.mjs <version> <tag> <newNotesJson> <existingLatestJson>
//
// Prints the merged latest.json to stdout. Keeps only the 10 most recent versions in the map.
const [, , version, tag, newNotesJson, existingJson] = process.argv;

const notes = JSON.parse(newNotesJson || '[]');
let existing = {};
try {
  existing = JSON.parse(existingJson || '{}');
} catch {
  existing = {};
}

const changelogs =
  existing && typeof existing.changelogs === 'object' && existing.changelogs ? { ...existing.changelogs } : {};
changelogs[version] = notes;

const semver = (v) =>
  String(v)
    .replace(/^v/, '')
    .split('.')
    .map(Number);
const descending = (a, b) => {
  const A = semver(a);
  const B = semver(b);
  return B[0] - A[0] || B[1] - A[1] || B[2] - A[2];
};

const trimmed = {};
for (const v of Object.keys(changelogs).sort(descending).slice(0, 10)) trimmed[v] = changelogs[v];

process.stdout.write(JSON.stringify({ tag, version, changelog: notes, changelogs: trimmed }));
