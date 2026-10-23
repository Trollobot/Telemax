import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HISTORY_DAYS, historyChoiceKeyboard, historyDaysLabel, historyDaysNotice, historyQuestionText } from '../src/bridge/history.js';
import { historyDepthView, systemView } from '../src/bridge/panel.js';
import { videoDimensions } from '../src/bridge/attachments.js';
import { NO_AUTO_UPDATE_TEXT } from '../src/bridge/fileShare.js';
import { SettingsStore } from '../src/store/settingsStore.js';

describe('history depth texts', () => {
  it('names the depth in Russian', () => {
    expect([1, 2, 5, 7, 21, 30, 0].map(historyDaysLabel)).toEqual(['1 день', '2 дня', '5 дней', '7 дней', '21 день', '30 дней', 'вся история']);
    expect(DEFAULT_HISTORY_DAYS).toBe(7);
  });

  it('a topic cut by the depth says how far back it goes and where to change it', () => {
    expect(historyDaysNotice(1)).toMatch(/^📜 Здесь история за последний день — более ранняя переписка осталась в MAX\./);
    expect(historyDaysNotice(7)).toMatch(/за последние 7 дней/);
    expect(historyDaysNotice(30)).toMatch(/\/panel → ⚙️ Система/);
  });

  it('the question offers four depths, the current one ticked, and says what happens without an answer', () => {
    const rows = historyChoiceKeyboard(7, 'tlmx_hist:');
    expect(rows.flat().map((b) => b.text)).toEqual(['1 день', '7 дней ✓', '30 дней', 'Вся история']);
    expect(rows.flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual(['tlmx_hist:1', 'tlmx_hist:7', 'tlmx_hist:30', 'tlmx_hist:0']);
    expect(historyChoiceKeyboard(0, 'x:').flat().map((b) => b.text)).toEqual(['1 день', '7 дней', '30 дней', 'Вся история ✓']);
    expect(historyQuestionText(7, 2)).toMatch(/Без ответа через 2 мин — 7 дней\./);
  });

  it('the panel shows the depth under ⚙️ Система and lets it be changed', () => {
    const labels = (v: ReturnType<typeof systemView>) => v.markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels(systemView(false, undefined, 30))).toContain('📜 История: 30 дней');
    expect(labels(systemView(false))).not.toContain('📜 История: 30 дней'); // no store wired — no button
    const view = historyDepthView(1);
    expect(view.text).toMatch(/^📜 История: 1 день/);
    expect(view.markup.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual([
      'tlmx_panel:history:1',
      'tlmx_panel:history:7',
      'tlmx_panel:history:30',
      'tlmx_panel:history:0',
      'tlmx_panel:system',
    ]);
  });
});

describe('SettingsStore', () => {
  it('starts empty, keeps what is set, and survives a reload', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'tlmx-settings-')), 'settings.json');
    const store = new SettingsStore(file);
    expect(await store.load()).toEqual({});
    expect(store.get().historyDays).toBeUndefined();
    await store.set({ historyDays: 30 });
    expect(store.get().historyDays).toBe(30);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ historyDays: 30 });
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().historyDays).toBe(30);
  });
});

describe('videoDimensions', () => {
  it("passes MAX's size of a video on to Telegram, nothing when it is missing or nonsense", () => {
    expect(videoDimensions({ width: 720, height: 1280 })).toEqual({ width: 720, height: 1280 }); // a vertical phone video
    expect(videoDimensions({ width: 0, height: 1280 })).toEqual({});
    expect(videoDimensions({})).toEqual({});
    expect(videoDimensions({ width: 'x', height: 5 })).toEqual({});
    expect(videoDimensions({ width: 99_999, height: 5 })).toEqual({});
  });
});

describe('no auto-update on the server', () => {
  it('says the cause, why it stops big files, and what to do — including the manual install', () => {
    expect(NO_AUTO_UPDATE_TEXT).toMatch(/^на этом сервере не работает автообновление Телемакса\.\n\nПочему это мешает: /);
    expect(NO_AUTO_UPDATE_TEXT).toMatch(/Что сделать: в папке моста на сервере выполните sudo \.\/setup\.sh/);
    expect(NO_AUTO_UPDATE_TEXT).toMatch(/FILES=off в \.env$/);
  });
});
