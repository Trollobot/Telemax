import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

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
    await writeFile(this.filePath, JSON.stringify(encoded), 'utf8');
  }

  async load(): Promise<MaxSession | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    const key = loadKey();
    const { iv, authTag, ciphertext } = JSON.parse(raw) as EncryptedFile;
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as MaxSession;
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
