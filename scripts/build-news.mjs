#!/usr/bin/env node
// Builds the site's news from CHANGELOG.md — the one changelog the bridge itself shows in its update
// notices — plus scripts/news.json (a headline and an emoji per version; `items` replaces a version's
// bullets when they read too technical for the site). Writes:
//   docs/news/index.html  — the news page (a timeline, early 0.x versions folded)
//   docs/news/feed.xml    — RSS 2.0 of the same
//   docs/index.html       — the «Новое» bar in the hero and softwareVersion (between markers)
//   docs/sitemap.xml      — lastmod of / and /news/
// Run after the CHANGELOG section of a release is written: `node scripts/build-news.mjs`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://telemax.svnest.ru';
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const write = (p, s) => {
  mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  writeFileSync(path.join(root, p), s);
};

// --- data ---------------------------------------------------------------------------------------
const titles = JSON.parse(read('scripts/news.json'));
const releases = [];
let cur = null;
for (const line of read('CHANGELOG.md').split(/\r?\n/)) {
  const h = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})\s*$/.exec(line);
  if (h) {
    cur = { version: h[1], date: h[2], items: [] };
    releases.push(cur);
    continue;
  }
  if (cur && line.startsWith('- ')) cur.items.push(line.slice(2).trim());
}
for (const r of releases) {
  const t = titles[r.version] ?? {};
  r.title = t.title ?? `Версия ${r.version}`;
  r.emoji = t.emoji ?? '🆕';
  if (Array.isArray(t.items)) r.items = t.items;
  r.items = r.items.map((i) => i.replace(/^\d+\.\d+\.\d+:\s*/, ''));
  const [major, minor, patch] = r.version.split('.').map(Number);
  r.major = patch === 0;
  r.early = major === 0;
  r.id = `v${r.version}`;
  if (!titles[r.version]) console.warn(`! no headline for ${r.version} in scripts/news.json — «${r.title}»`);
}
if (!releases.length) throw new Error('CHANGELOG.md: no releases found');
const latest = releases[0];

// --- formatting ---------------------------------------------------------------------------------
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const ymd = (d) => d.split('-').map(Number);
const dayMonth = (d) => `${ymd(d)[2]} ${MONTHS[ymd(d)[1] - 1]}`;
const fullDate = (d) => `${dayMonth(d)} ${ymd(d)[0]}`;
const monthTitle = (d) => `${MONTHS_NOM[ymd(d)[1] - 1]} ${ymd(d)[0]}`;
const rfc822 = (d) => new Date(`${d}T12:00:00+03:00`).toUTCString();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One bullet: escaped, commands and settings as code, the lead phrase («Трансляция:», «Вход в MAX снова работает.») bold. */
function bullet(text) {
  let s = esc(text);
  let lead = '';
  const cut = [s.indexOf('. '), s.indexOf(': '), s.indexOf(' — ')].filter((i) => i >= 3).sort((a, b) => a - b)[0];
  if (cut !== undefined && cut <= 70) {
    const end = s.startsWith(' — ', cut) ? cut : cut + 1;
    lead = s.slice(0, end);
    s = s.slice(end);
  }
  const code = (t) =>
    t.replace(
      /(^|[\s(«])((?:\.\/)?[a-z]+\.sh|\.env|\/[a-z]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:=[\w/.\-…]+)?|[A-Z]{2,}=[\w/.\-…]+)(?=$|[\s,.;:)»…])/g,
      '$1<code>$2</code>',
    );
  return lead ? `<b>${code(lead)}</b>${code(s)}` : code(s);
}

function card(r) {
  const tag = r.version === '1.0.0' ? '<span class="tag big">Версия 1.0</span>' : r.major ? '<span class="tag big">Крупное обновление</span>' : '';
  return `
      <article class="rel${r.major ? ' major' : ''}" id="${r.id}">
        <div class="meta"><a class="ver" href="#${r.id}" title="Ссылка на эту новость">v${r.version}</a><time datetime="${r.date}">${dayMonth(r.date)}</time>${tag}</div>
        <h3><span class="em" aria-hidden="true">${r.emoji}</span> ${esc(r.title)}</h3>
        <ul>
${r.items.map((i) => `          <li>${bullet(i)}</li>`).join('\n')}
        </ul>
      </article>`;
}

/** Releases grouped under month headings, newest first. */
function timeline(list) {
  let out = '';
  let month = '';
  for (const r of list) {
    const m = monthTitle(r.date);
    if (m !== month) {
      if (month) out += '\n    </div>';
      out += `\n    <div class="month"><h2 class="mh">${m}</h2>`;
      month = m;
    }
    out += card(r);
  }
  return out + (month ? '\n    </div>' : '');
}

// --- the news page ------------------------------------------------------------------------------
const main = releases.filter((r) => !r.early);
const early = releases.filter((r) => r.early);
const first = releases[releases.length - 1];
const ld = {
  '@context': 'https://schema.org',
  '@type': 'Blog',
  name: 'Новости Telemax',
  url: `${SITE}/news/`,
  inLanguage: 'ru',
  blogPost: main.slice(0, 20).map((r) => ({
    '@type': 'BlogPosting',
    headline: `Telemax ${r.version}: ${r.title}`,
    datePublished: r.date,
    url: `${SITE}/news/#${r.id}`,
    author: { '@type': 'Organization', name: 'Telemax' },
  })),
};

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Новости Telemax — что нового в мосте MAX ↔ Telegram</title>
<meta name="description" content="Что нового в Telemax: все версии моста MAX ↔ Telegram по-человечески. Последняя — ${latest.version} от ${fullDate(latest.date)}: ${esc(latest.title)}.">
<link rel="canonical" href="${SITE}/news/">
<link rel="alternate" type="application/rss+xml" title="Новости Telemax" href="${SITE}/news/feed.xml">
<meta property="og:type" content="website">
<meta property="og:locale" content="ru_RU">
<meta property="og:site_name" content="Telemax">
<meta property="og:title" content="Новости Telemax — ${esc(latest.title)}">
<meta property="og:description" content="Все версии моста MAX ↔ Telegram: что появилось и что починили.">
<meta property="og:url" content="${SITE}/news/">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="../icon.png">
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
<style>
  :root{
    --paper:#f5ecd9; --paper-2:#faf4e6; --card:#fffdf8;
    --ink:#2b2119; --muted:#6f6152; --faint:#948676;
    --line:#e4d4b6; --line-soft:#eaddc4;
    --terra:#c2571f; --terra-dark:#9d4315; --terra-tint:#f0dcbb;
    --olive:#7a7433; --ok:#4d7c2f;
    --serif:Georgia,"Times New Roman","PT Serif",serif;
    --radius:14px; --shadow:0 1px 2px rgba(70,45,20,.05),0 14px 34px rgba(90,55,20,.09);
  }
  *{box-sizing:border-box}
  html{scroll-padding-top:80px}
  body{margin:0;background:var(--paper);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.62;-webkit-font-smoothing:antialiased}
  a{color:var(--terra-dark);text-decoration:none}
  a:hover{text-decoration:underline}
  .wrap{max-width:860px;margin:0 auto;padding:0 22px}
  h1,h2,h3{font-family:var(--serif);line-height:1.18;margin:0 0 .4em;font-weight:700}
  .btn{display:inline-block;padding:11px 18px;border-radius:12px;font-weight:700;border:1.5px solid transparent;font-size:.95rem}
  .btn-primary{background:var(--terra);color:#fff8ef}
  .btn-primary:hover{background:var(--terra-dark);text-decoration:none}
  .btn-ghost{background:transparent;border-color:var(--line);color:var(--ink)}
  .btn-ghost:hover{border-color:var(--terra);text-decoration:none}
  header.nav{position:sticky;top:0;z-index:10;background:rgba(245,236,217,.86);
    backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
  .nav .wrap{max-width:1000px;display:flex;align-items:center;gap:16px;height:62px}
  .brand{font-family:var(--serif);font-weight:700;font-size:1.35rem;letter-spacing:-.01em;color:var(--ink);display:inline-flex;align-items:center;gap:9px}
  .brand:hover{text-decoration:none}
  .brand .dot{color:var(--terra)}
  .nav .spacer{flex:1}
  .nav a.navlink{color:var(--muted);font-weight:600;font-size:.94rem}
  .nav a.navlink.on{color:var(--terra-dark)}
  @media(max-width:680px){.nav a.navlink{display:none}.nav a.navlink.on{display:inline}}
  code{background:var(--terra-tint);color:var(--terra-dark);padding:1px 6px;border-radius:6px;
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
  /* top */
  .top{padding:54px 0 18px}
  .kicker{color:var(--terra);font-weight:700;text-transform:uppercase;letter-spacing:.09em;font-size:.76rem;margin-bottom:10px}
  .top h1{font-size:clamp(2rem,5.4vw,3.1rem);letter-spacing:-.01em}
  .top .lead{color:var(--muted);font-size:clamp(1.02rem,2.2vw,1.18rem);max-width:640px;margin:0 0 22px}
  .actions{display:flex;gap:10px;flex-wrap:wrap}
  .facts{display:flex;gap:10px;flex-wrap:wrap;margin-top:26px}
  .fact{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:.86rem;color:var(--muted)}
  .fact b{color:var(--ink)}
  /* timeline */
  .feed{position:relative;padding:18px 0 30px}
  .month{position:relative;padding-left:34px}
  .month::before{content:"";position:absolute;left:9px;top:0;bottom:0;width:2px;background:var(--line)}
  .mh{font-size:.8rem;font-family:inherit;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);
    margin:28px 0 14px;position:relative}
  .mh::before{content:"";position:absolute;left:-30px;top:3px;width:12px;height:12px;border-radius:50%;
    background:var(--paper);border:2px solid var(--line)}
  .rel{position:relative;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
    padding:20px 24px 16px;margin-bottom:16px;box-shadow:var(--shadow)}
  .rel::before{content:"";position:absolute;left:-31px;top:26px;width:14px;height:14px;border-radius:50%;
    background:var(--card);border:3px solid var(--terra-tint)}
  .rel.major{border-left:5px solid var(--terra);padding-left:20px}
  .rel.major::before{background:var(--terra);border-color:var(--terra-tint);width:16px;height:16px;left:-36px;top:24px}
  .rel:target{outline:3px solid var(--terra-tint);outline-offset:2px}
  .meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:.85rem;color:var(--faint);margin-bottom:6px}
  .ver{font-weight:800;color:var(--terra-dark);background:var(--terra-tint);border-radius:999px;padding:2px 10px;font-size:.8rem}
  .ver:hover{text-decoration:none;background:var(--terra);color:#fff8ef}
  .tag.big{font-weight:700;color:var(--ok);background:#eef3e3;border:1px solid #d3e0bd;border-radius:999px;padding:1px 9px;font-size:.76rem}
  .rel h3{font-size:clamp(1.12rem,2.6vw,1.32rem);margin:0 0 8px}
  .rel h3 .em{margin-right:2px}
  .rel ul{margin:0;padding-left:20px;color:var(--muted);font-size:.95rem}
  .rel li{margin:0 0 7px}
  .rel li b{color:var(--ink);font-weight:650}
  .rel li::marker{color:var(--terra)}
  /* early versions */
  details.early{margin-top:22px;background:var(--paper-2);border:1px solid var(--line);border-radius:var(--radius);padding:4px 20px}
  details.early>summary{cursor:pointer;list-style:none;padding:14px 0;font-family:var(--serif);font-weight:700;font-size:1.05rem}
  details.early>summary::-webkit-details-marker{display:none}
  details.early>summary::before{content:"＋";color:var(--terra);font-weight:800;margin-right:10px}
  details.early[open]>summary::before{content:"－"}
  details.early .sub{color:var(--muted);font-weight:400;font-family:inherit;font-size:.9rem}
  details.early .rel{box-shadow:none}
  @media(max-width:560px){.month{padding-left:24px}.month::before{left:5px}.mh::before{left:-24px}
    .rel{padding:16px 16px 12px}.rel.major{padding-left:14px}.rel::before{left:-25px}.rel.major::before{left:-29px}
    details.early{padding:4px 12px}}
  /* bottom */
  .howto{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:24px 26px;margin:10px 0 0;box-shadow:var(--shadow)}
  .howto h2{font-size:1.3rem}
  .howto p{color:var(--muted);margin:0 0 10px}
  footer{padding:40px 0 60px;color:var(--muted);border-top:1px solid var(--line);margin-top:46px}
  footer .links{display:flex;gap:12px 20px;flex-wrap:wrap;margin-bottom:18px}
  .disc{font-size:.85rem;background:var(--paper-2);border:1px solid var(--line);border-radius:12px;padding:15px 18px}
</style>
</head>
<body>

<header class="nav">
  <div class="wrap">
    <a class="brand" href="../">
      <img src="../icon.png" alt="Telemax" width="30" height="30" style="border-radius:8px;display:block">
      <span>Tele<span class="dot">max</span></span>
    </a>
    <span class="spacer"></span>
    <a class="navlink" href="../#features">Возможности</a>
    <a class="navlink" href="../max-v-telegram/">Инструкция</a>
    <a class="navlink on" href="./">Новости</a>
    <a class="navlink" href="../#faq">Вопросы</a>
    <a class="navlink" href="https://github.com/Trollobot/Telemax">GitHub</a>
  </div>
</header>

<main class="wrap">
  <div class="top">
    <div class="kicker">Новости</div>
    <h1>Что нового в Telemax</h1>
    <p class="lead">Каждая версия моста — коротко и по-человечески. О новой версии бот сам скажет в группе, а обновиться можно одной кнопкой «Обновить» в <code>/version</code>.</p>
    <div class="actions">
      <a class="btn btn-primary" href="#${latest.id}">${latest.emoji} Версия ${latest.version}</a>
      <a class="btn btn-ghost" href="feed.xml">📡 RSS-лента</a>
      <a class="btn btn-ghost" href="../#how">Как установить</a>
    </div>
    <div class="facts">
      <span class="fact">Последняя версия — <b>${latest.version}</b>, ${fullDate(latest.date)}</span>
      <span class="fact"><b>${releases.length}</b> версий с ${fullDate(first.date)}</span>
    </div>
  </div>

  <div class="feed">${timeline(main)}
${
  early.length
    ? `
    <details class="early">
      <summary>Ранние версии ${early[early.length - 1].version} — ${early[0].version} <span class="sub">· ${dayMonth(early[early.length - 1].date)} — ${fullDate(early[0].date)}</span></summary>
${timeline(early)}
    </details>`
    : ''
}
  </div>

  <div class="howto">
    <h2>Как обновиться</h2>
    <p>Бот сам проверяет обновления раз в сутки и пишет в группу, что нового. Обновиться — кнопкой «Обновить» в этом сообщении или в <code>/version</code>: мост пересоберётся за пару минут, переписка не потеряется. Каждый релиз подписан, а если обновление сорвётся, мост вернётся на прежнюю версию.</p>
    <p style="margin:0">Ещё не поставили? <a href="../max-v-telegram/">Пошаговая инструкция</a> · есть идея или нашли баг — <a href="https://t.me/TelemaxSvv_bot">напишите боту</a>.</p>
  </div>
</main>

<footer>
  <div class="wrap" style="max-width:1000px">
    <div class="links">
      <a href="../">Главная</a>
      <a href="https://github.com/Trollobot/Telemax">GitHub</a>
      <a href="https://github.com/Trollobot/Telemax/blob/main/CHANGELOG.md">CHANGELOG на GitHub</a>
      <a href="feed.xml">RSS</a>
      <a href="https://t.me/TelemaxSvv_bot">Баг или идея — боту @TelemaxSvv_bot</a>
      <a href="../stats/">📊 Статистика посещений</a>
    </div>
    <div class="disc">⚠️ Неофициальный проект с открытым кодом. Не связан с MAX и Telegram. Работает с вашим собственным аккаунтом — на ваш страх и риск.</div>
    <p style="margin-top:16px">© Telemax — бесплатный мост MAX ↔ Telegram · AGPL-3.0</p>
  </div>
</footer>

<script>
  // Счётчик посещений без cookie: сообщает только, откуда пришли и на каком адресе открыт сайт.
  // Сервер сразу раскладывает это по счётчикам и IP не хранит — см. /stats/.
  (function () {
    var h = location.hostname;
    if (location.protocol !== 'https:' || h === 'localhost' || h === '127.0.0.1') return;
    try {
      var body = JSON.stringify({ r: document.referrer || '', h: h });
      var url = 'https://telemax.svnest.ru/api/site/hit';
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      else fetch(url, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' });
    } catch (e) {}
  })();
</script>

</body>
</html>
`;
write('docs/news/index.html', page);

// --- RSS ----------------------------------------------------------------------------------------
const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Новости Telemax</title>
  <link>${SITE}/news/</link>
  <atom:link href="${SITE}/news/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Что нового в Telemax — бесплатном мосте MAX ↔ Telegram с открытым кодом</description>
  <language>ru</language>
  <lastBuildDate>${rfc822(latest.date)}</lastBuildDate>
${releases
  .slice(0, 30)
  .map(
    (r) => `  <item>
    <title>${esc(`Telemax ${r.version}: ${r.title}`)}</title>
    <link>${SITE}/news/#${r.id}</link>
    <guid isPermaLink="false">telemax-${r.version}</guid>
    <pubDate>${rfc822(r.date)}</pubDate>
    <description><![CDATA[<ul>${r.items.map((i) => `<li>${bullet(i)}</li>`).join('')}</ul>]]></description>
  </item>`,
  )
  .join('\n')}
</channel>
</rss>
`;
write('docs/news/feed.xml', rss);

// --- the landing: «Новое» bar and softwareVersion ----------------------------------------------
let index = read('docs/index.html');
const nl = index.includes('\r\n') ? '\r\n' : '\n';
const bar = `<!-- news:latest -->${nl}    <a class="newsbar" href="news/#${latest.id}"><span class="nb-tag">Новое · v${latest.version}</span><span class="nb-text">${latest.emoji} ${esc(latest.title)}</span><span class="nb-go" aria-hidden="true">→</span></a>${nl}    <!-- /news:latest -->`;
if (!/<!-- news:latest -->[\s\S]*?<!-- \/news:latest -->/.test(index)) throw new Error('docs/index.html: <!-- news:latest --> markers missing');
index = index.replace(/<!-- news:latest -->[\s\S]*?<!-- \/news:latest -->/, bar);
index = index.replace(/"softwareVersion": "[^"]*"/, `"softwareVersion": "${latest.version}"`);
index = index.replace(/"dateModified": "[^"]*"/, `"dateModified": "${latest.date}"`);
write('docs/index.html', index);

// --- sitemap: lastmod of the pages a release changes --------------------------------------------
let sitemap = read('docs/sitemap.xml');
for (const loc of [`${SITE}/`, `${SITE}/news/`]) {
  sitemap = sitemap.replace(new RegExp(`(<loc>${loc.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</loc>\\s*<lastmod>)[^<]*(</lastmod>)`), `$1${latest.date}$2`);
}
write('docs/sitemap.xml', sitemap);

console.log(`news: ${releases.length} releases, latest ${latest.version} (${latest.date}) — docs/news/index.html, docs/news/feed.xml, docs/index.html, docs/sitemap.xml`);
