#!/usr/bin/env node
// Maintainer-only: builds the portable Windows archive — build/portable/Telemax/ and, next to it,
// Telemax-portable-<version>.zip. Run on Windows from the repo root:
//
//   node scripts/build-portable.mjs                 Node.js runtime copied from this machine
//   node scripts/build-portable.mjs --node=22.20.0  that release downloaded from nodejs.org,
//                                                   checked against its SHASUMS256.txt
//   node scripts/build-portable.mjs --no-zip        the folder only (for a local test run)
//
// What goes in: the two bundles (bridge + launcher, see src/portable), production node_modules,
// node.exe, certs, VERSION, and the Windows files from portable/ (Telemax.cmd, tray.ps1, README.txt).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);

const args = process.argv.slice(2);
const nodeArg = args.find((a) => a.startsWith('--node='))?.slice('--node='.length) ?? 'local';
const zip = !args.includes('--no-zip');
const version = readFileSync('VERSION', 'utf8').trim();
const out = path.join(repo, 'build', 'portable');
const stage = path.join(out, 'Telemax');
const app = path.join(stage, 'app');
const BOM = '\uFEFF';

const run = (cmd, cmdArgs, cwd = repo) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
const step = (text) => console.log(`\n>> ${text}`);
// Not cpSync({ recursive }): on Windows it kills Node 22 without a word when the path has non-ASCII letters.
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

step(`Telemax portable ${version}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(app, 'dist'), { recursive: true });

step('bundles: bridge + launcher');
const esbuild = ['esbuild', '--bundle', '--platform=node', '--format=esm', '--packages=external', '--log-level=warning'];
run('npx', [...esbuild, 'src/server/app.ts', `--outfile=${path.join(app, 'dist', 'server.mjs')}`]);
run('npx', [...esbuild, 'src/portable/launcher.ts', `--outfile=${path.join(app, 'dist', 'launcher.mjs')}`]);

step('production node_modules');
cpSync('package.json', path.join(app, 'package.json'));
cpSync('package-lock.json', path.join(app, 'package-lock.json'));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], app);
rmSync(path.join(app, 'package-lock.json'));

step(`Node.js runtime (${nodeArg})`);
const nodeExe = path.join(app, 'node.exe');
if (nodeArg === 'local') {
  if (process.platform !== 'win32') throw new Error('--node=local works on Windows only: pass --node=<version>');
  cpSync(process.execPath, nodeExe);
  console.log(`   copied ${process.execPath} (${process.version})`);
} else {
  const base = `https://nodejs.org/dist/v${nodeArg}`;
  const cache = path.join(repo, 'build', 'cache', `node-v${nodeArg}-win-x64.exe`);
  if (!existsSync(cache)) {
    mkdirSync(path.dirname(cache), { recursive: true });
    const res = await fetch(`${base}/win-x64/node.exe`);
    if (!res.ok) throw new Error(`node.exe ${nodeArg}: HTTP ${res.status}`);
    writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  }
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.trim().endsWith('win-x64/node.exe'))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(cache)).digest('hex');
  if (!expected || expected !== actual) {
    rmSync(cache, { force: true });
    throw new Error(`node.exe ${nodeArg}: checksum mismatch (expected ${expected}, got ${actual})`);
  }
  cpSync(cache, nodeExe);
  console.log(`   node.exe ${nodeArg}, sha256 ${actual.slice(0, 16)}… verified`);
}

step('certs, VERSION, Windows files');
copyDir('certs', path.join(stage, 'certs'));
// «+win» marks the portable build wherever the version shows: on its page, in /version, and in
// the anonymous ping — the only way to tell Windows installs from servers in the statistics
// without sending anything new (the ping carries the install id and the version, nothing else).
writeFileSync(path.join(stage, 'VERSION'), `${version}+win\n`, 'utf8');
cpSync('LICENSE', path.join(stage, 'LICENSE.txt'));
// cmd.exe wants CRLF; PowerShell 5.1 and Notepad want a BOM to read UTF-8 Cyrillic as such.
const crlf = (text) => text.replace(/\r?\n/g, '\r\n');
writeFileSync(path.join(stage, 'Telemax.cmd'), crlf(readFileSync('portable/Telemax.cmd', 'utf8')), 'utf8');
writeFileSync(path.join(app, 'tray.ps1'), BOM + crlf(readFileSync('portable/tray.ps1', 'utf8')), 'utf8');
writeFileSync(path.join(stage, 'README.txt'), BOM + crlf(readFileSync('portable/README.txt', 'utf8')), 'utf8');

if (zip) {
  const archive = path.join(out, `Telemax-portable-${version}.zip`);
  step(`archive: ${path.relative(repo, archive)}`);
  rmSync(archive, { force: true });
  // bsdtar ships with Windows 10+ (System32\tar.exe); -a picks zip from the extension.
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', archive, '-C', out, 'Telemax'], { stdio: 'inherit' });
  const bytes = readFileSync(archive);
  console.log(`   ${(bytes.length / 1024 / 1024).toFixed(1)} MB, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}
console.log(`\n>> Done: ${path.relative(repo, stage)}`);
