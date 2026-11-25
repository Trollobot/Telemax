import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import {
  getMaxProxy,
  loadMaxProxyOverride,
  MaxProxyError,
  maxProxySource,
  openMaxTunnel,
  proxyUrlProblem,
  saveMaxProxyOverride,
  setMaxProxyOverride,
} from '../src/max/proxy.js';
import { maxProxyView } from '../src/bridge/panel.js';
import { outageCause } from '../src/server/maxSession.js';

/** A minimal SOCKS5 proxy (no auth, CONNECT only) — enough to see a real tunnel open. */
function socks5Server(): Promise<{ port: number; close: () => void; connects: string[] }> {
  const connects: string[] = [];
  const server = net.createServer((client) => {
    client.once('data', () => {
      client.write(Buffer.from([5, 0])); // version 5, no authentication
      client.once('data', (req) => {
        const atyp = req[3];
        let host = '';
        let at = 4;
        if (atyp === 1) {
          host = [...req.subarray(4, 8)].join('.');
          at = 8;
        } else if (atyp === 3) {
          const len = req[4]!;
          host = req.subarray(5, 5 + len).toString();
          at = 5 + len;
        }
        const port = req.readUInt16BE(at);
        connects.push(`${host}:${port}`);
        const target = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          client.pipe(target).pipe(client);
        });
        target.on('error', () => client.destroy());
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close(), connects })));
}

afterEach(() => setMaxProxyOverride(null));

describe('MAX proxy — the tunnel', () => {
  it('opens a plain stream to MAX through a SOCKS5 proxy', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as net.AddressInfo).port;
    const proxy = await socks5Server();
    try {
      const socket = await openMaxTunnel(`socks5://127.0.0.1:${proxy.port}`, '127.0.0.1', echoPort);
      const back = await new Promise<string>((resolve) => {
        socket.once('data', (d) => resolve(d.toString()));
        socket.write('ping');
      });
      expect(back).toBe('ping');
      expect(proxy.connects).toEqual([`127.0.0.1:${echoPort}`]);
      socket.destroy();
    } finally {
      proxy.close();
      echo.close();
    }
  });

  it('says it was the proxy when the proxy is not there, without its password', async () => {
    const err = await openMaxTunnel('socks5://user:secret@127.0.0.1:1', 'api2.oneme.ru', 443, 3000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaxProxyError);
    expect((err as Error).message).toMatch(/^MAX proxy /);
    expect((err as Error).message).not.toContain('secret');
    expect(outageCause((err as Error).message)).toBe('proxy');
  });
});

describe('MAX proxy — the setting', () => {
  it('takes socks5 and http addresses with a port, and says what is wrong with anything else', () => {
    expect(proxyUrlProblem('socks5://user:pass@1.2.3.4:1080')).toBeNull();
    expect(proxyUrlProblem('http://proxy.example.ru:3128')).toBeNull();
    expect(proxyUrlProblem('tg://proxy?server=x')).toMatch(/не подходит/);
    expect(proxyUrlProblem('socks5://1.2.3.4')).toMatch(/порта/);
    expect(proxyUrlProblem('просто текст')).toMatch(/не адрес прокси/);
  });

  it('the panel’s setting wins over MAX_PROXY, and removing it brings .env back', () => {
    const env = { MAX_PROXY: 'socks5://env:1080' };
    expect(getMaxProxy(env)).toBe('socks5://env:1080');
    expect(maxProxySource(env)).toBe('env');
    setMaxProxyOverride('socks5://panel:1080');
    expect(getMaxProxy(env)).toBe('socks5://panel:1080');
    expect(maxProxySource(env)).toBe('panel');
    setMaxProxyOverride(null);
    expect(getMaxProxy(env)).toBe('socks5://env:1080');
    expect(getMaxProxy({})).toBe('');
    expect(maxProxySource({})).toBe('none');
  });

  it('keeps the panel’s proxy across restarts in a file only the bridge can read', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mproxy-'));
    const file = path.join(dir, 'max-proxy');
    try {
      await saveMaxProxyOverride('socks5://u:p@5.6.7.8:1080', file);
      expect((await readFile(file, 'utf8')).trim()).toBe('socks5://u:p@5.6.7.8:1080');
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
      setMaxProxyOverride(null);
      await loadMaxProxyOverride(file);
      expect(getMaxProxy({})).toBe('socks5://u:p@5.6.7.8:1080');
      await saveMaxProxyOverride(null, file);
      await loadMaxProxyOverride(file);
      expect(maxProxySource({})).toBe('none');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the panel shows where the proxy comes from, never its password', () => {
    expect(maxProxyView({ shown: 'socks5://5.6.7.8:1080', source: 'panel' }).text).toMatch(/через прокси socks5:\/\/5\.6\.7\.8:1080 \(задан здесь/);
    expect(maxProxyView({ shown: 'http://p:3128', source: 'env' }).text).toMatch(/из MAX_PROXY в \.env/);
    expect(maxProxyView({ shown: '', source: 'none' }).text).toMatch(/напрямую, без прокси/);
  });
});

describe('MAX proxy — a quiet tunnel', () => {
  it('is not cut by the connect timeout once it is open', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as net.AddressInfo).port;
    const proxy = await socks5Server();
    try {
      const socket = await openMaxTunnel(`socks5://127.0.0.1:${proxy.port}`, '127.0.0.1', echoPort, 300);
      await new Promise((r) => setTimeout(r, 700)); // idle for longer than the connect timeout
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    } finally {
      proxy.close();
      echo.close();
    }
  });
});
