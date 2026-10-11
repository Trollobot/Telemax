import { describe, expect, it } from 'vitest';
import {
  cleanIp,
  createGeo,
  createSiteStats,
  ipv4ToNum,
  ipv6Prefix,
  isBot,
  mskDay,
  mskHour,
  siteOf,
  sourceOf,
  summarize,
} from '../telemetry-server/site.mjs';

// The landing visit counter (telemetry-server/site.mjs): aggregates only, no IPs on disk.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
// 2026-10-11 10:00 UTC = 13:00 MSK
const T = Date.UTC(2026, 9, 11, 10, 0, 0);

describe('time and sources', () => {
  it('days and hours follow Moscow time', () => {
    expect(mskDay(Date.UTC(2026, 9, 11, 20, 59))).toBe('2026-10-11');
    expect(mskDay(Date.UTC(2026, 9, 11, 21, 0))).toBe('2026-10-12');
    expect(mskHour(T)).toBe(13);
  });

  it('groups referrers into sources', () => {
    expect(sourceOf('')).toBe('direct');
    expect(sourceOf(undefined)).toBe('direct');
    expect(sourceOf('not a url')).toBe('direct');
    expect(sourceOf('https://habr.com/ru/articles/1092754/')).toBe('habr.com');
    expect(sourceOf('https://www.google.ru/')).toBe('google');
    expect(sourceOf('https://yandex.ru/search/?text=x')).toBe('yandex');
    expect(sourceOf('https://t.me/')).toBe('telegram');
    expect(sourceOf('https://github.com/Trollobot/Telemax')).toBe('github.com');
    expect(sourceOf('https://vc.ru/id973711/3179706')).toBe('vc.ru');
    expect(sourceOf('https://telemax.svnest.ru/stats/')).toBe('internal');
    expect(sourceOf('https://trollobot.github.io/Telemax/')).toBe('internal');
  });

  it('knows our sites and bots', () => {
    expect(siteOf('telemax.svnest.ru')).toBe('telemax.svnest.ru');
    expect(siteOf('TROLLOBOT.github.io')).toBe('trollobot.github.io');
    expect(siteOf('evil.example')).toBe('other');
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot('curl/8.5.0')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot(UA)).toBe(false);
  });
});

describe('GeoIP table', () => {
  const geo = createGeo(
    [
      '1.0.0.0,1.0.0.255,AU',
      '5.3.0.0,5.3.255.255,RU',
      '46.8.0.0,46.8.255.255,LV',
      '2a00:1fa0::,2a00:1fa3:ffff:ffff:ffff:ffff:ffff:ffff,RU',
      '2a13:7c00::,2a13:7c00:ffff:ffff:ffff:ffff:ffff:ffff,LV',
      'garbage line',
      '',
    ].join('\n'),
  );

  it('parses addresses', () => {
    expect(ipv4ToNum('5.3.1.2')).toBe(0x05030102);
    expect(ipv4ToNum('255.255.255.255')).toBe(0xffffffff);
    expect(ipv4ToNum('256.1.1.1')).toBeNull();
    expect(ipv6Prefix('2a13:7c00:6:6:f816:3eff:fee0:7adb')).toBe(0x2a137c0000060006n);
    expect(ipv6Prefix('2a00:1fa1::1')).toBe(0x2a001fa100000000n);
    expect(ipv6Prefix('::ffff:1.2.3.4')).toBe(0n);
    expect(ipv6Prefix('1.2.3.4')).toBeNull();
    expect(cleanIp('::ffff:5.3.1.2')).toBe('5.3.1.2');
  });

  it('finds countries for v4, v6 and mapped addresses', () => {
    expect(geo.size).toBe(5);
    expect(geo.lookup('5.3.10.20')).toBe('RU');
    expect(geo.lookup('::ffff:46.8.238.57')).toBe('LV');
    expect(geo.lookup('2a00:1fa2::5')).toBe('RU');
    expect(geo.lookup('2a13:7c00:6:6:f816:3eff:fee0:7adb')).toBe('LV');
    expect(geo.lookup('8.8.8.8')).toBe('');
    expect(geo.lookup('nonsense')).toBe('');
  });
});

describe('counters', () => {
  it('counts views, daily unique visitors, hours, countries, sources and sites', () => {
    const s = createSiteStats();
    const hit = (o: Partial<Parameters<typeof s.hit>[0]> = {}) =>
      s.hit({ ip: '5.3.1.2', ua: UA, referrer: 'https://habr.com/ru/articles/1092754/', host: 'telemax.svnest.ru', country: 'RU', now: T, ...o });
    expect(hit()).toBe(true);
    expect(hit({ now: T + 60_000 })).toBe(true); // same visitor reloads
    expect(hit({ ip: '46.8.1.1', referrer: '', host: 'trollobot.github.io', country: 'LV' })).toBe(true);
    expect(hit({ ua: 'Googlebot/2.1' })).toBe(false);
    const day = s.days['2026-10-11']!;
    expect(day.views).toBe(3);
    expect(day.visitors).toBe(2);
    expect(day.hours[13]).toBe(3);
    expect(day.countries).toEqual({ RU: 1, LV: 1 });
    expect(day.sources).toEqual({ 'habr.com': 1, direct: 1 });
    expect(day.sites).toEqual({ 'telemax.svnest.ru': 2, 'trollobot.github.io': 1 });
  });

  it('never saves an address, a user agent or a hash', () => {
    const s = createSiteStats();
    s.hit({ ip: '5.3.1.2', ua: UA, referrer: '', host: 'telemax.svnest.ru', country: 'RU', now: T });
    const saved = JSON.stringify(s);
    expect(saved).not.toContain('5.3.1.2');
    expect(saved).not.toContain('Mozilla');
    expect(Object.keys(JSON.parse(saved))).toEqual(['days']);
  });

  it('a new Moscow day counts the same visitor again; navigation inside the site is not a source', () => {
    const s = createSiteStats();
    s.hit({ ip: '5.3.1.2', ua: UA, referrer: '', host: 'telemax.svnest.ru', country: 'RU', now: T });
    s.hit({ ip: '5.3.1.2', ua: UA, referrer: 'https://telemax.svnest.ru/stats/', host: 'telemax.svnest.ru', country: 'RU', now: T + 86_400_000 });
    expect(s.days['2026-10-12']!.visitors).toBe(1);
    expect(s.days['2026-10-12']!.sources).toEqual({});
  });

  it('keeps saved days and prunes old ones', () => {
    const s = createSiteStats({ days: { '2024-01-01': { views: 1, visitors: 1, hours: Array(24).fill(0), countries: {}, sources: {}, sites: {} } } });
    expect(Object.keys(s.days)).toEqual(['2024-01-01']);
    s.prune(T);
    expect(Object.keys(s.days)).toEqual([]);
  });
});

describe('summary', () => {
  it('totals, a 30-day series and top lists', () => {
    const s = createSiteStats();
    s.hit({ ip: '5.3.1.2', ua: UA, referrer: 'https://habr.com/', host: 'telemax.svnest.ru', country: 'RU', now: T - 86_400_000 });
    s.hit({ ip: '5.3.1.2', ua: UA, referrer: '', host: 'telemax.svnest.ru', country: 'RU', now: T });
    s.hit({ ip: '46.8.1.1', ua: UA, referrer: 'https://vc.ru/', host: 'telemax.svnest.ru', country: 'LV', now: T });
    const sum = summarize(s.days, T);
    expect(sum.today).toEqual({ views: 2, visitors: 2 });
    expect(sum.yesterday).toEqual({ views: 1, visitors: 1 });
    expect(sum.last7).toEqual({ views: 3, visitors: 3 });
    expect(sum.total).toEqual({ views: 3, visitors: 3 });
    expect(sum.since).toBe('2026-10-10');
    expect(sum.days).toHaveLength(30);
    expect(sum.days.at(-1)).toEqual({ d: '2026-10-11', views: 2, visitors: 2 });
    expect(sum.countries[0]).toEqual(['RU', 2]);
    expect(sum.sources).toEqual(expect.arrayContaining([['habr.com', 1], ['direct', 1], ['vc.ru', 1]]));
    expect(sum.hours[13]).toBe(3);
    expect(JSON.stringify(sum)).not.toMatch(/install/i);
  });
});
