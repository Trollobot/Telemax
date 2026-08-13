/**
 * One-shot SMS login for manual verification against the real MAX server.
 * Per max-protocol-full.md §1.5/§3, the whole auth chain (DEVICE_INFO ->
 * START_AUTH -> CHECK_CODE -> LOGIN) has to happen on a single TCP
 * connection, so this stays a single long-lived process rather than
 * separate "start" / "verify" invocations.
 *
 * Usage: npm run auth:cli -- +79991234567
 * Then, once the SMS arrives, write the code to .data/sms-code.txt
 * (any tool/editor works — the script polls for it).
 */
import 'dotenv/config';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MaxClient } from '../../src/max/client.js';
import { SessionStore } from '../../src/store/sessionStore.js';

const CODE_FILE = path.join(process.cwd(), '.data', 'sms-code.txt');
const CODE_POLL_INTERVAL_MS = 500;
const CODE_WAIT_TIMEOUT_MS = 5 * 60_000;

function mask(token: string): string {
  if (token.length <= 12) return '***';
  return `${token.slice(0, 6)}...${token.slice(-4)} (${token.length} chars)`;
}

async function waitForCodeFile(): Promise<string> {
  await mkdir(path.dirname(CODE_FILE), { recursive: true });
  await rm(CODE_FILE, { force: true });
  console.log(`Waiting for SMS code in ${CODE_FILE} (write the digits and save) ...`);

  const deadline = Date.now() + CODE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const content = (await readFile(CODE_FILE, 'utf8')).trim();
      if (content) {
        await rm(CODE_FILE, { force: true });
        return content;
      }
    } catch {
      // file not there yet — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, CODE_POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for the SMS code');
}

async function main(): Promise<void> {
  const phone = process.argv[2];
  if (!phone) {
    console.error('Usage: npm run auth:cli -- <phone, e.g. +79991234567>');
    process.exitCode = 1;
    return;
  }

  const client = new MaxClient({ reconnect: false });

  client.on('error', (err: Error) => console.error('[MAX error]', err.message));
  client.on('sent', ({ opcode, length }: { opcode: number; length: number }) =>
    console.log(`-> opcode 0x${opcode.toString(16)} (${length} B)`),
  );
  client.on('message', ({ opcode, dir, length }: { opcode: number; dir: number; length: number }) =>
    console.log(`<- opcode 0x${opcode.toString(16)} dir=0x${dir.toString(16)} (${length} B)`),
  );

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for INIT ack')), 20_000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  console.log(`Connecting (deviceId=${client.deviceId}) ...`);
  client.connect();
  await ready;
  console.log('Connected and initialized.');

  console.log(`Requesting SMS code for ${phone} ...`);
  const authToken = await client.requestSms(phone);
  console.log('Got auth_token:', mask(authToken));

  const code = await waitForCodeFile();
  console.log('Verifying code ...');
  const loginToken = await client.verifyCode(authToken, code);
  console.log('Got login_token:', mask(loginToken));

  console.log('Logging in ...');
  const { sessionToken } = await client.login(loginToken);
  console.log('Got session_token:', mask(sessionToken));

  await new SessionStore().save({
    sessionToken,
    phone,
    deviceId: client.deviceId,
    savedAt: new Date().toISOString(),
  });
  console.log('Session saved to .data/max.session.json (encrypted).');

  client.disconnect();
  process.exitCode = 0;
}

main().catch((err) => {
  console.error('Auth flow failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
