import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('session');

export interface MaxSession {
  sessionToken: string;
  phone: string;
  deviceId: string;
  savedAt: string;
}

const ALGO = 'aes-256-gcm';

function loadKey(): Buffer {
  const hex = process.env.MAX_SESSION_KEY;
  if (!hex) {
    throw new Error(
      'MAX_SESSION_KEY is not set. Generate one with ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` ' +
        'and put it in .env — session tokens are never stored unencrypted (see ТЗ.md §3.2).',
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('MAX_SESSION_KEY must be a 32-byte value, hex-encoded (64 hex chars)');
  }
  return key;
}

interface EncryptedFile {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Encrypted, disk-persisted store for the MAX session token (ТЗ.md §1.4, §3.2). */
export class SessionStore {
  /** Set when load() had to park an unreadable session file — startup uses it to say so in Telegram. */
  corruptedOnLoad = false;

  // save() runs on every reconnect (MAX rotates the token) and the auth flow can fire one at the same
  // moment. Two overlapping writes each write-then-rename the SAME tmp path, and the second rename
  // hits ENOENT because the first already moved it — the exact race that corrupted chat-map.json in
  // production, which is why ChatMapStore grew this queue. Same medicine here.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = path.join(process.cwd(), '.data', 'max.session.json')) {}

  async save(session: MaxSession): Promise<void> {
    const key = loadKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const encoded: EncryptedFile = {
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    // write-then-rename, same as ChatMapStore: save() runs on every reconnect (MAX rotates the token),
    // so a crash or a power cut mid-write is a real possibility — and a truncated file used to make
    // load() throw on every boot, which with `restart: unless-stopped` is an endless restart loop
    // curable only by deleting the file over SSH.
    const run = this.writeQueue.then(async () => {
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(encoded), 'utf8');
      await rename(tmpPath, this.filePath);
    });
    // Keep the queue moving even if this write failed, so one bad write can't wedge every later one.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<MaxSession | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    // DELIBERATELY outside the try below: a missing or malformed MAX_SESSION_KEY is an operator
    // configuration error, and it must stay loud. Swallowing it here would park a perfectly good
    // session file as "corrupt" the moment someone starts the bridge without its key.
    const key = loadKey();
    try {
      const { iv, authTag, ciphertext } = JSON.parse(raw) as EncryptedFile;
      const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(authTag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as MaxSession;
    } catch (err) {
      // Truncated file, or one encrypted with a DIFFERENT MAX_SESSION_KEY — the classic way in is
      // restoring ./data onto a fresh install without carrying .env across, which README used to
      // present as a complete backup. This threw straight out of startServer and killed the process
      // on every boot: an endless restart loop with not one word in Telegram. Park the file instead
      // (renamed, never deleted — it's still decryptable if the right key turns up) and come up
      // unauthenticated; the operator just needs /login.
      this.corruptedOnLoad = true;
      const parked = `${this.filePath}.broken`;
      await rename(this.filePath, parked).catch(() => {});
      logger.error(`Не удалось прочитать сохранённую MAX-сессию — файл перемещён в ${path.basename(parked)}. Нужна повторная авторизация: /login`, err);
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
