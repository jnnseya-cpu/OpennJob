import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption of personal data at rest: CV text, the credential passport and supporting
 * statements. AES-256-GCM, a fresh random 96-bit nonce per value, and the value's
 * "context" (which column of which user's row) bound in as additional authenticated
 * data, so a ciphertext copied into another row or another user's record fails to decrypt.
 *
 * Stored form:  enc:v1:<base64( nonce[12] | tag[16] | ciphertext )>
 *
 * KEY MANAGEMENT AND ROTATION ARE THE OPERATOR'S JOB. This code takes one key from
 * OPENNJOB_DATA_KEY and does nothing else: it does not generate, store, escrow, version
 * or rotate keys. Lose the key and the data is unreadable. See README, "Encryption at rest".
 */
export interface FieldCipher {
  /** True when values are really encrypted (a key is configured). */
  readonly enabled: boolean;
  encrypt(plaintext: string, context: string): string;
  /** Throws DecryptionError when the value was altered, moved, or encrypted under another key. */
  decrypt(stored: string, context: string): string;
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export const ENCRYPTED_PREFIX = 'enc:v1:';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Reads OPENNJOB_DATA_KEY: exactly 32 bytes, base64. Returns undefined when it is not
 * set. Throws when it is set but is not a 32-byte key: a wrong key must never be
 * silently treated as "no encryption".
 */
export function parseDataKey(raw: string | undefined): Buffer | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error('OPENNJOB_DATA_KEY must be base64');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`OPENNJOB_DATA_KEY must decode to exactly 32 bytes (got ${key.length})`);
  return key;
}

export class AesGcmCipher implements FieldCipher {
  readonly enabled = true;
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('AES-256-GCM needs a 32-byte key');
    this.key = Buffer.from(key);
  }

  encrypt(plaintext: string, context: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ENCRYPTED_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
  }

  decrypt(stored: string, context: string): string {
    // A value written before a key was configured is plain text. It is returned as it is
    // and becomes ciphertext the next time it is saved.
    if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;
    const raw = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64');
    if (raw.length < NONCE_BYTES + TAG_BYTES) throw new DecryptionError('Stored value is too short to be valid ciphertext');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      // Deliberately no detail: the cause is a wrong key, a changed value or a moved value.
      throw new DecryptionError('Stored value could not be decrypted (wrong key, or the value was altered or moved)');
    }
  }
}

/** Used when OPENNJOB_DATA_KEY is not set (development only; production refuses to start). */
export class PlaintextCipher implements FieldCipher {
  readonly enabled = false;
  encrypt(plaintext: string): string {
    return plaintext;
  }
  decrypt(stored: string): string {
    if (stored.startsWith(ENCRYPTED_PREFIX)) throw new DecryptionError('Stored value is encrypted but OPENNJOB_DATA_KEY is not set');
    return stored;
  }
}

export function cipherFromEnv(raw: string | undefined): FieldCipher {
  const key = parseDataKey(raw);
  return key ? new AesGcmCipher(key) : new PlaintextCipher();
}
