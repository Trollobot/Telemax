import { describe, expect, it } from 'vitest';
import { adminDmHintText, bridgeGroupLink } from '../src/bridge/sync.js';
import { systemView } from '../src/bridge/panel.js';

describe('the bridge admin in the bot DM', () => {
  it('is told where the bridge lives — the group, and /login as the one DM command', () => {
    const text = adminDmHintText('Мой мост');
    expect(text).toMatch(/только вход в MAX — \/login/);
    expect(text).toMatch(/в группе моста «Мой мост»:/);
    expect(text).toMatch(/\/panel — пульт, в общей теме/);
    expect(adminDmHintText('')).toMatch(/в группе моста:/);
  });

  it('gets a members link to the supergroup', () => {
    expect(bridgeGroupLink('-1003919540013')).toBe('https://t.me/c/3919540013');
  });
});

describe('«⚙️ Система» in the panel', () => {
  const data = (v: ReturnType<typeof systemView>) => v.markup.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
  it('offers «🔁 Перезапустить мост» and carries a note after a restart', () => {
    expect(data(systemView(false))).toContain('tlmx_panel:restart');
    expect(data(systemView(true))).toContain('tlmx_panel:resume');
    expect(systemView(false).text).toBe('⚙️ Система:');
    expect(systemView(false, '✅ Мост перезапущен — всё работает.').text).toBe('⚙️ Система:\n✅ Мост перезапущен — всё работает.');
  });
});

describe('«🚪 Выйти из MAX»', () => {
  it('asks first, says the topics stay, and goes back where it came from', async () => {
    const { logoutConfirmView } = await import('../src/bridge/panel.js');
    const v = logoutConfirmView('+7999***9999', { text: '◀️ Назад', data: 'tlmx_panel:web' });
    expect(v.text).toMatch(/^🚪 Выйти из MAX \(\+7999\*\*\*9999\)\?/);
    expect(v.text).toMatch(/завершится и в самом MAX/);
    expect(v.text).toMatch(/Темы, история и настройки останутся/);
    expect(v.markup.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual(['tlmx_panel:logout:go', 'tlmx_panel:web']);
  });
});
