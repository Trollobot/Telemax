// Telemax files service — serves the bridges' big-file links (see src/bridge/fileShare.ts).
//
// Runs behind Caddy (TLS) in the shared `telemax-files` compose project that
// files-service/reconcile.sh starts on the host only while some bridge has a live link. Plain
// Node built-ins, no build step and no dependencies: the container is the stock node image with
// this directory mounted read-only. Each bridge's `data/files` directory is mounted at
// /srv/<n>; a link token is looked up in every one of them.
//
//   GET  /health                → ok
//   GET  /f/<token>             → a page: «Скачать» for a download, a file picker for an upload
//   GET  /f/<token>/file        → the file itself (Range supported — a broken download resumes)
//   PUT  /f/<token>/upload      → the uploaded body, streamed to disk (X-File-Name: URI-encoded)
//
// A page is not the file: link previews (MAX and Telegram fetch every URL sent into a chat) only
// ever see the page, so they can't burn an upload link or start a multi-gigabyte download.
import http from 'node:http';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const ROOT = process.env.FILES_ROOT || '/srv';
const PORT = Number(process.env.PORT || 8080);
const TZ = process.env.TZ || 'Europe/Moscow';
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

/** @returns {Promise<{root: string, token: string, body: any} | null>} */
async function findToken(token) {
  if (!TOKEN_RE.test(token)) return null;
  let roots = [];
  try {
    roots = (await readdir(ROOT)).map((d) => path.join(ROOT, d));
  } catch {
    return null;
  }
  for (const root of roots) {
    try {
      const body = JSON.parse(await readFile(path.join(root, 'tokens', `${token}.json`), 'utf8'));
      if (typeof body.expiresAt !== 'number' || body.expiresAt <= Date.now()) return null;
      return { root, token, body };
    } catch {
      /* not this bridge */
    }
  }
  return null;
}

/** Strict inside-the-root resolution: a token's path can't point anywhere else. */
function inside(root, rel) {
  const full = path.resolve(root, rel);
  return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

function safeName(raw) {
  let name = String(raw ?? '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim().replace(/^\.+/, '').trim();
  if (!name) name = 'file';
  return name.length > 180 ? name.slice(0, 180) : name;
}

function formatBytes(b) {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} ГБ`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} МБ`;
  return `${Math.max(1, Math.round(b / 1024))} КБ`;
}

function formatDate(ms) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(ms));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function page(res, status, title, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--fg:#1c1d21;--mut:#6b6f7a;--acc:#2a7de1;--bar:#e3e6eb}
@media(prefers-color-scheme:dark){:root{--bg:#15171b;--card:#1f2228;--fg:#e8eaee;--mut:#9aa0ab;--bar:#30343c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.c{background:var(--card);border-radius:16px;padding:28px;max-width:440px;width:calc(100% - 32px);box-sizing:border-box;box-shadow:0 2px 14px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 6px}.m{color:var(--mut);font-size:14px;margin:0 0 18px;word-break:break-word}
.b{display:block;width:100%;box-sizing:border-box;text-align:center;background:var(--acc);color:#fff;border:0;border-radius:10px;padding:13px;font-size:16px;text-decoration:none;cursor:pointer}
.b[disabled]{opacity:.5;cursor:default}input[type=file]{width:100%;margin:0 0 14px}
.p{height:8px;background:var(--bar);border-radius:4px;overflow:hidden;margin:14px 0 6px;display:none}.p i{display:block;height:100%;width:0;background:var(--acc)}
.s{font-size:14px;color:var(--mut);min-height:21px}.f{margin-top:18px;font-size:12px;color:var(--mut)}
</style></head><body><div class="c">${body}<div class="f">Telemax · ссылка действует ограниченное время, потом файл удаляется</div></div></body></html>`);
}

function notFound(res) {
  page(res, 404, 'Ссылка недействительна', '<h1>Ссылка недействительна</h1><p class="m">Ссылка устарела, уже использована или набрана с ошибкой. Попросите прислать новую.</p>');
}

async function freeBytes(root) {
  const s = await statfs(root);
  return Number(s.bavail) * Number(s.bsize);
}

async function showLink(res, t) {
  const { body, token } = t;
  if (body.kind === 'download') {
    page(
      res,
      200,
      body.name,
      `<h1>${esc(body.name)}</h1><p class="m">${esc(formatBytes(body.size))} · ссылка действует до ${esc(formatDate(body.expiresAt))}</p>
<a class="b" href="/f/${token}/file">Скачать</a>`,
    );
    return;
  }
  if (body.kind === 'upload') {
    const done = await stat(path.join(t.root, 'incoming', token, 'done.json')).then(() => true, () => false);
    if (done) {
      page(res, 410, 'Файл уже получен', '<h1>Файл уже получен</h1><p class="m">Мост отправит его в MAX. Эту страницу можно закрыть.</p>');
      return;
    }
    const maxBytes = Math.max(0, (await freeBytes(t.root)) - (body.reserveBytes ?? 0));
    page(
      res,
      200,
      'Загрузка файла',
      `<h1>Загрузите файл</h1><p class="m">Ждём «${esc(body.name)}» (${esc(formatBytes(body.expectedSize ?? 0))}). Мост отправит его в MAX.<br>Можно выбрать и другой файл — до ${esc(formatBytes(maxBytes))}. Ссылка действует до ${esc(formatDate(body.expiresAt))}.</p>
<input type="file" id="f"><button class="b" id="go" disabled>Отправить</button>
<div class="p" id="p"><i id="bar"></i></div><div class="s" id="s"></div>
<script>
const f=document.getElementById('f'),go=document.getElementById('go'),s=document.getElementById('s'),p=document.getElementById('p'),bar=document.getElementById('bar');
const MAX=${maxBytes};
const fmt=b=>b>=1073741824?(b/1073741824).toFixed(1)+' ГБ':b>=1048576?Math.round(b/1048576)+' МБ':Math.max(1,Math.round(b/1024))+' КБ';
f.onchange=()=>{const x=f.files[0];s.textContent='';go.disabled=!x;if(x&&x.size>MAX){s.textContent='Файл '+fmt(x.size)+' не поместится: на сервере свободно '+fmt(MAX)+'.';go.disabled=true}};
go.onclick=()=>{const x=f.files[0];if(!x)return;go.disabled=true;f.disabled=true;p.style.display='block';
const r=new XMLHttpRequest();r.open('PUT',location.pathname.replace(/\\/$/,'')+'/upload');r.setRequestHeader('X-File-Name',encodeURIComponent(x.name));
r.upload.onprogress=e=>{if(e.lengthComputable){bar.style.width=(e.loaded/e.total*100).toFixed(1)+'%';s.textContent=fmt(e.loaded)+' из '+fmt(e.total)}};
r.onload=()=>{if(r.status===200){bar.style.width='100%';s.textContent='Готово! Мост отправит файл в MAX — страницу можно закрыть.'}else{s.textContent='Не получилось: '+(r.responseText||r.status);go.disabled=false;f.disabled=false}};
r.onerror=()=>{s.textContent='Связь прервалась — попробуйте ещё раз.';go.disabled=false;f.disabled=false};r.send(x)};
</script>`,
    );
    return;
  }
  notFound(res);
}

async function sendFile(req, res, t) {
  const { root, body } = t;
  if (body.kind !== 'download') return notFound(res);
  const full = inside(root, body.path);
  if (!full) return notFound(res);
  let size;
  try {
    size = (await stat(full)).size;
  } catch {
    return notFound(res);
  }
  const name = safeName(body.name);
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Accept-Ranges': 'bytes',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (start < 0) start = 0;
    if (end >= size) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    if (req.method === 'HEAD') return res.end();
    return pipeline(createReadStream(full, { start, end }), res).catch(() => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(size) });
  if (req.method === 'HEAD') return res.end();
  return pipeline(createReadStream(full), res).catch(() => {});
}

function reply(res, status, text) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function receiveUpload(req, res, t) {
  const { root, token, body } = t;
  if (body.kind !== 'upload') return reply(res, 404, 'Ссылка недействительна');
  const length = Number(req.headers['content-length']);
  if (!Number.isFinite(length) || length <= 0) return reply(res, 411, 'Не указан размер файла');
  const room = (await freeBytes(root)) - (body.reserveBytes ?? 0);
  if (length > room) return reply(res, 507, `Не хватает места на сервере: свободно ${formatBytes(Math.max(0, room))}`);

  const dir = path.join(root, 'incoming', token);
  await mkdir(dir, { recursive: true });
  if (await stat(path.join(dir, 'done.json')).then(() => true, () => false)) return reply(res, 410, 'Файл по этой ссылке уже получен');
  // One upload at a time per link: the lock file is created exclusively and removed on failure.
  let lock;
  try {
    lock = await open(path.join(dir, '.lock'), 'wx');
  } catch {
    return reply(res, 409, 'По этой ссылке уже идёт загрузка');
  }
  let rawName = 'file';
  try {
    rawName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'));
  } catch {
    /* keep the default */
  }
  const name = safeName(rawName);
  const part = path.join(dir, `${name}.part`);
  let received = 0;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      cb(received > length ? new Error('body longer than Content-Length') : null, chunk);
    },
  });
  try {
    await pipeline(req, guard, createWriteStream(part));
    if (received !== length) throw new Error(`got ${received} of ${length} bytes`);
    await rename(part, path.join(dir, name));
    await writeFile(path.join(dir, 'done.json'), JSON.stringify({ name, file: name, size: received, at: Date.now() }));
    reply(res, 200, 'ok');
  } catch (err) {
    await rm(part, { force: true });
    if (!res.headersSent) reply(res, 400, `Загрузка прервалась: ${err.message}`);
  } finally {
    await lock.close().catch(() => {});
    await rm(path.join(dir, '.lock'), { force: true });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') return reply(res, 200, 'ok');
    const m = /^\/f\/([A-Za-z0-9_-]+)(\/file|\/upload)?\/?$/.exec(url.pathname);
    if (!m) return notFound(res);
    const t = await findToken(m[1]);
    if (!t) return m[2] === '/upload' ? reply(res, 404, 'Ссылка недействительна или устарела') : notFound(res);
    if (!m[2] && (req.method === 'GET' || req.method === 'HEAD')) return await showLink(res, t);
    if (m[2] === '/file' && (req.method === 'GET' || req.method === 'HEAD')) return await sendFile(req, res, t);
    if (m[2] === '/upload' && (req.method === 'PUT' || req.method === 'POST')) return await receiveUpload(req, res, t);
    reply(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) reply(res, 500, 'Внутренняя ошибка');
    else res.destroy();
  }
});
// Gigabyte uploads outlast Node's default 5-minute request timeout.
server.requestTimeout = 0;
server.listen(PORT, () => console.log(`telemax files service on :${PORT}, roots under ${ROOT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
