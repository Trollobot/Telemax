import { describe, expect, it } from 'vitest';
import { MaxServerError, parsePublicSearch } from '../src/max/client.js';
import { OPCODES } from '../src/max/opcodes.js';
import { addToMaxContacts, cardButtons, contactAddFailure, normalizeNickQuery, normalizePhoneQuery, profileName } from '../src/bridge/panel.js';

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

describe('normalizePhoneQuery', () => {
  it('drops spaces, dashes and brackets', () => {
    expect(normalizePhoneQuery('+7 (916) 123-45-67')).toBe('+79161234567');
    expect(normalizePhoneQuery('+7-916-123-45-67')).toBe('+79161234567');
    expect(normalizePhoneQuery(' 7 916 123 45 67 ')).toBe('+79161234567');
  });
  it('turns the Russian trunk «8» and a bare 10-digit number into +7', () => {
    expect(normalizePhoneQuery('8 (916) 123-45-67')).toBe('+79161234567');
    expect(normalizePhoneQuery('89161234567')).toBe('+79161234567');
    expect(normalizePhoneQuery('9161234567')).toBe('+79161234567');
  });
  it('keeps a Telegram contact number (digits, no plus) and other countries as they are', () => {
    expect(normalizePhoneQuery('79161234567')).toBe('+79161234567');
    expect(normalizePhoneQuery('+375 29 123-45-67')).toBe('+375291234567');
    expect(normalizePhoneQuery('+8 916 123 45 67')).toBe('+89161234567');
  });
  it('rejects what is not a phone number', () => {
    expect(normalizePhoneQuery('')).toBeNull();
    expect(normalizePhoneQuery('12345')).toBeNull();
    expect(normalizePhoneQuery('abc')).toBeNull();
    expect(normalizePhoneQuery('1234567890123456')).toBeNull();
  });
});

describe('«➕ В контакты MAX» on the search card', () => {
  const data = (buttons: Array<{ callback_data: string }>) => buttons.map((b) => b.callback_data);

  it('is offered to a person on MAX who is not a contact yet — not to bots, contacts or non-MAX numbers', () => {
    expect(data(cardButtons('42', { name: 'Вася', onMax: true }))).toEqual(['tlmx_panel:startchat:42', 'tlmx_panel:addcontact:42', 'tlmx_panel:dismiss']);
    expect(data(cardButtons('42', { name: 'Вася', onMax: true, added: true }))).toEqual(['tlmx_panel:startchat:42', 'tlmx_panel:dismiss']);
    expect(data(cardButtons('42', { name: 'Бот', onMax: true, bot: true }))).toEqual(['tlmx_panel:startchat:42', 'tlmx_panel:dismiss']);
    expect(data(cardButtons('42', { name: 'Вася', onMax: false }))).toEqual(['tlmx_panel:dismiss']);
  });

  it('saves under the MAX profile name, split into first and last', () => {
    expect(profileName({ id: 1, names: [{ firstName: 'Вася', lastName: 'Пупкин', type: 'ONEME' }] })).toEqual({ firstName: 'Вася', lastName: 'Пупкин' });
    expect(profileName({ id: 1, names: [{ firstName: 'Вася', lastName: '', type: 'ONEME' }] })).toEqual({ firstName: 'Вася', lastName: undefined });
    expect(profileName({ id: 1, names: [{ name: 'Вася Пупкин Младший' }] })).toEqual({ firstName: 'Вася', lastName: 'Пупкин Младший' });
    expect(profileName({ id: 7 })).toEqual({ firstName: 'MAX', lastName: '7' });
  });

  it('explains what MAX refused', () => {
    const refused = (code: string) => new MaxServerError('x', OPCODES.CONTACT_ADD, code);
    expect(contactAddFailure(refused('error.add.self'))).toMatch(/собственный номер/);
    expect(contactAddFailure(refused('error.invalid-phone'))).toMatch(/номер неверным/);
    expect(contactAddFailure(refused('user.not.found'))).toMatch(/не нашёл/);
    expect(contactAddFailure(new Error('timeout'))).toBe('❌ Не удалось добавить в контакты: timeout');
  });
  it('adds by phone under the given name, else by id, and says what happened', async () => {
    const calls: unknown[] = [];
    const max = {
      addContactByPhone: async (phone: string, firstName: string, lastName?: string) => {
        calls.push(['phone', phone, firstName, lastName]);
        return { contact: { id: 1 }, isNew: true };
      },
      addContactById: async (id: unknown) => {
        calls.push(['id', id]);
        return null;
      },
    };
    expect(await addToMaxContacts(max, '1', { phone: '+79161234567', saveAs: { firstName: 'Вася', lastName: 'Пупкин' } })).toEqual({ ok: true, line: '✅ Добавлен в контакты MAX как «Вася Пупкин».' });
    expect(await addToMaxContacts(max, '1', {})).toEqual({ ok: true, line: '✅ Добавлен в контакты MAX.' });
    expect(calls).toEqual([['phone', '+79161234567', 'Вася', 'Пупкин'], ['id', '1']]);
    const refusing = {
      ...max,
      addContactByPhone: async () => {
        throw new MaxServerError('x', OPCODES.CONTACT_ADD, 'error.add.self');
      },
    };
    expect(await addToMaxContacts(refusing, '1', { phone: '+79161234567', saveAs: { firstName: 'Я' } })).toMatchObject({ ok: false, line: expect.stringMatching(/собственный номер/) });
  });
});
