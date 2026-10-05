import { describe, expect, it } from 'vitest';
import { parsePublicSearch } from '../src/max/client.js';
import { normalizeNickQuery } from '../src/bridge/panel.js';

describe('parsePublicSearch', () => {
  it('reads the live 2026-10-05 shape: double-nested bot contacts and channels', () => {
    const payload = {
      result: [
        {
          contact: {
            contact: { id: 543835, names: [{ name: 'Безопасность', type: 'ONEME' }], options: ['ONEME', 'BOT'], link: 'https://max.ru/maxbot' },
            summary: '@maxbot',
            presence: { seen: 1, status: 3 },
          },
          highlights: ['maxbot'],
        },
        { chat: { id: -76656736668180n, type: 'CHANNEL', title: 'АЗС Радар', link: 'https://max.ru/azs_radar' }, highlights: [] },
        { chat: { id: -1n, type: 'CHANNEL', title: 'Без ссылки' } },
      ],
      total: 3,
      ucpQId: 'x',
    };
    const { contacts, channels } = parsePublicSearch(payload);
    expect(contacts.map((c) => c.id)).toEqual([543835]);
    expect(contacts[0]!.link).toBe('https://max.ru/maxbot');
    expect(channels).toEqual([
      { id: -76656736668180n, title: 'АЗС Радар', link: 'https://max.ru/azs_radar' },
      { id: -1n, title: 'Без ссылки', link: undefined },
    ]);
  });

  it('still accepts a single-nested contact and an empty answer', () => {
    expect(parsePublicSearch({ result: [{ contact: { id: 7, names: [] } }] }).contacts.map((c) => c.id)).toEqual([7]);
    expect(parsePublicSearch({ result: [], total: 0 })).toEqual({ contacts: [], channels: [] });
    expect(parsePublicSearch(null)).toEqual({ contacts: [], channels: [] });
  });
});

describe('normalizeNickQuery', () => {
  it('strips «@» — MAX finds nothing with it (live 2026-10-05)', () => {
    expect(normalizeNickQuery('@maxbot')).toEqual({ query: 'maxbot' });
    expect(normalizeNickQuery('  maxbot ')).toEqual({ query: 'maxbot' });
  });

  it('takes the nick out of a pasted max.ru link', () => {
    expect(normalizeNickQuery('https://max.ru/maxbot')).toEqual({ query: 'maxbot' });
    expect(normalizeNickQuery('max.ru/maxbot/')).toEqual({ query: 'maxbot' });
    expect(normalizeNickQuery('https://max.ru/maxbot?start=1')).toEqual({ query: 'maxbot' });
  });

  it('recognises personal and invite links the catalog cannot resolve', () => {
    expect(normalizeNickQuery('https://max.ru/u/f9LHodD0cOKx')).toEqual({ personalLink: true });
    expect(normalizeNickQuery('max.ru/join/abc')).toEqual({ personalLink: true });
  });

  it('keeps titles with spaces and rejects an empty query', () => {
    expect(normalizeNickQuery('АЗС Радар')).toEqual({ query: 'АЗС Радар' });
    expect(normalizeNickQuery('@')).toBeNull();
    expect(normalizeNickQuery('https://max.ru/')).toBeNull();
  });
});
