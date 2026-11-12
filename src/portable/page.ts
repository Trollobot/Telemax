/**
 * The launcher's one page: connection state, settings (first-run setup is the same form), the log.
 * Served to 127.0.0.1 only; everything dynamic goes in through textContent, never as markup.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telemax</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --text:#1c1e21; --muted:#667085; --line:#e3e6ea; --accent:#2a7de1; --ok:#1f9d55; --warn:#d08a00; --bad:#d64545; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --card:#1f2228; --text:#e8eaed; --muted:#9aa3b2; --line:#2d323a; --accent:#5aa2f5; --ok:#3ecf7e; --warn:#f0b541; --bad:#ff6b6b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { max-width:760px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:16px; margin:0 0 12px; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:16px; }
  .row { display:flex; gap:12px; align-items:flex-start; padding:8px 0; border-top:1px solid var(--line); }
  .row:first-of-type { border-top:0; }
  .dot { width:12px; height:12px; border-radius:50%; margin-top:6px; flex:none; background:var(--muted); }
  .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); } .dot.bad { background:var(--bad); }
  .name { width:92px; flex:none; font-weight:600; }
  .grow { flex:1; min-width:0; overflow-wrap:anywhere; }
  label { display:block; font-weight:600; margin:14px 0 4px; }
  .hint { color:var(--muted); font-size:13px; margin:4px 0 0; }
  input[type=text], input[type=password] { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
  input:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .line { display:flex; gap:8px; }
  .line input { flex:1; min-width:0; }
  button { padding:9px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font:inherit; cursor:pointer; white-space:nowrap; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button:disabled { opacity:.55; cursor:default; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
  .msg { margin:8px 0 0; font-size:14px; white-space:pre-line; }
  .msg.ok { color:var(--ok); } .msg.bad { color:var(--bad); }
  .groups button { display:block; width:100%; text-align:left; margin-top:6px; white-space:normal; }
  ol { margin:6px 0 0; padding-left:20px; }
  pre { margin:0; max-height:340px; overflow:auto; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px; font:12px/1.45 Consolas, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
  details summary { cursor:pointer; font-weight:600; }
  @media (max-width:520px) { .line { flex-direction:column; } .name { width:76px; } }
</style>
</head>
<body>
<main>
  <h1>Telemax</h1>
  <p class="sub" id="sub">Мост MAX ↔ Telegram на этом компьютере</p>

  <section class="card" aria-live="polite">
    <h2>Состояние</h2>
    <div id="status"><div class="row"><span class="dot"></span><span class="grow">Загрузка…</span></div></div>
    <p class="hint" id="next"></p>
    <div class="actions">
      <button id="restart">Перезапустить мост</button>
    </div>
    <p class="msg" id="restartMsg"></p>
  </section>

  <section class="card">
    <h2 id="setupTitle">Настройки</h2>
    <div id="guide" hidden>
      <p class="hint">Понадобятся бот и группа в Telegram:</p>
      <ol class="hint">
        <li>Создайте бота у @BotFather (команда /newbot) и скопируйте его токен.</li>
        <li>Создайте группу, включите в ней «Темы» и добавьте бота администратором с правом «Управление темами».</li>
        <li>Напишите в группу любое сообщение — так бот её увидит.</li>
      </ol>
    </div>

    <label for="token">Токен бота</label>
    <input type="password" id="token" autocomplete="off" spellcheck="false">
    <p class="hint" id="tokenHint"></p>

    <label for="proxy">Прокси для Telegram (необязательно)</label>
    <div class="line">
      <input type="text" id="proxy" autocomplete="off" spellcheck="false" placeholder="socks5://логин:пароль@адрес:порт">
      <button id="check">Проверить связь</button>
    </div>
    <p class="hint">Нужен, только если Telegram с этого компьютера не открывается напрямую. Подходит SOCKS5 или HTTP-прокси. Пустое поле — без прокси.</p>
    <p class="msg" id="checkMsg"></p>

    <label for="group">Группа Telegram (её номер)</label>
    <div class="line">
      <input type="text" id="group" autocomplete="off" spellcheck="false" placeholder="-1001234567890">
      <button id="find">Найти группу</button>
      <button id="checkGroup">Проверить</button>
    </div>
    <div class="groups" id="groups"></div>
    <p class="msg" id="groupMsg"></p>

    <div class="actions">
      <button class="primary" id="save">Сохранить и запустить</button>
    </div>
    <p class="msg" id="saveMsg"></p>
  </section>

  <section class="card">
    <details id="logBox">
      <summary>Журнал</summary>
      <p class="hint" id="logPath"></p>
      <pre id="log"></pre>
    </details>
  </section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const api = async (path, body) => {
    const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-telemax': '1' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({ ok: false, error: 'нет ответа от программы' }));
    if (!res.ok && json.ok !== false) return { ok: false, error: 'ошибка ' + res.status };
    return json;
  };
  const say = (id, ok, text) => { const el = $(id); el.className = 'msg ' + (ok ? 'ok' : 'bad'); el.textContent = text; };
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
  // What the form holds that the user typed; untouched fields mean "as saved".
  const typed = () => ({ token: $('token').value.trim(), proxy: $('proxy').value.trim(), group: $('group').value.trim() });
  let filled = false;

  function render(s) {
    const box = $('status');
    box.textContent = '';
    for (const line of s.health.lines) {
      const row = document.createElement('div'); row.className = 'row';
      const dot = document.createElement('span'); dot.className = 'dot ' + line.level;
      const name = document.createElement('span'); name.className = 'name'; name.textContent = line.name;
      const text = document.createElement('span'); text.className = 'grow'; text.textContent = line.text;
      row.append(dot, name, text); box.append(row);
    }
    document.title = (s.health.level === 'ok' ? '' : '⚠ ') + 'Telemax';
    $('sub').textContent = 'Мост MAX ↔ Telegram на этом компьютере · версия ' + s.version;
    $('restart').hidden = !s.configured;
    $('guide').hidden = s.configured;
    $('setupTitle').textContent = s.configured ? 'Настройки' : 'Первый запуск';
    $('next').textContent = s.configured && s.needsLogin ? 'Осталось войти в MAX: напишите боту' + (s.settings.bot ? ' @' + s.settings.bot : '') + ' в личку команду /login.' : '';
    $('tokenHint').textContent = s.settings.tokenSet ? 'Токен сохранён' + (s.settings.bot ? ' (бот @' + s.settings.bot + ')' : '') + '. Оставьте поле пустым, чтобы не менять.' : 'Выглядит так: 123456789:AAE…';
    $('logPath').textContent = 'Полный журнал: ' + s.logFile;
    if (!filled) { filled = true; $('proxy').value = s.settings.proxy; $('group').value = s.settings.group; }
  }

  async function refresh() {
    const s = await api('/api/status').catch(() => null);
    if (s && s.health) render(s);
    else { $('status').textContent = 'Программа не отвечает — запустите Telemax.cmd заново.'; }
    if ($('logBox').open) {
      const l = await api('/api/log').catch(() => null);
      if (l && l.lines) { const pre = $('log'); const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20; pre.textContent = l.lines.join('\\n'); if (atEnd) pre.scrollTop = pre.scrollHeight; }
    }
  }

  $('check').onclick = () => busy($('check'), async () => {
    say('checkMsg', true, 'Проверяю…');
    const r = await api('/api/check', typed());
    say('checkMsg', r.ok, r.ok ? 'Связь с Telegram есть' + (r.viaProxy ? ' через прокси' : ' напрямую') + '. Бот: @' + r.bot.username + (r.ms ? ' · ответ за ' + r.ms + ' мс' : '') : r.error);
  });
  $('find').onclick = () => busy($('find'), async () => {
    say('groupMsg', true, 'Ищу группы, где есть бот…');
    $('groups').textContent = '';
    const r = await api('/api/find-group', typed());
    if (!r.ok) return say('groupMsg', false, r.error);
    if (r.groups.length === 0) return say('groupMsg', false, 'Пока не вижу ни одной группы. Добавьте бота в группу администратором, напишите в неё любое сообщение и нажмите «Найти группу» ещё раз.');
    say('groupMsg', true, r.groups.length === 1 ? 'Нашёл группу — нажмите на неё:' : 'Выберите группу:');
    for (const g of r.groups) {
      const b = document.createElement('button'); b.textContent = (g.title || 'Без названия') + '  (' + g.id + ')';
      b.onclick = () => { $('group').value = g.id; $('groups').textContent = ''; $('checkGroup').click(); };
      $('groups').append(b);
    }
  });
  $('checkGroup').onclick = () => busy($('checkGroup'), async () => {
    say('groupMsg', true, 'Проверяю группу…');
    const r = await api('/api/check-group', typed());
    say('groupMsg', r.ok, r.ok ? 'Группа «' + r.title + '» подходит: темы включены, бот — администратор.' : (r.problems ? r.problems.join('\\n') : r.error));
  });
  $('save').onclick = () => busy($('save'), async () => {
    say('saveMsg', true, 'Сохраняю…');
    const r = await api('/api/settings', typed());
    say('saveMsg', r.ok, r.ok ? 'Сохранено, мост запускается. ' + (r.note || '') : r.error);
    if (r.ok) { $('token').value = ''; filled = false; refresh(); }
  });
  $('restart').onclick = () => busy($('restart'), async () => {
    const r = await api('/api/restart', {});
    say('restartMsg', r.ok, r.ok ? 'Мост перезапускается.' : r.error);
    setTimeout(() => { $('restartMsg').textContent = ''; }, 6000);
  });
  $('logBox').addEventListener('toggle', refresh);
  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>
`;
