// Seals a credential held in a retry record under a key that only the caller entitled to that retry
// can supply: the bearer token they presented when the operation first ran. The hub keeps that token
// only as a hash, so a reader of the store alone can open nothing. Pure: no file or network access.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export type Sealed = { v: 1; salt: string; nonce: string; data: string };

const INFO = 'agentlink retry credential v1';
const TAG = 16;
const derive = (presented: string, salt: Buffer) => Buffer.from(hkdfSync('sha256', Buffer.from(presented, 'utf8'), salt, INFO, 32));
const part = (value: unknown, bytes: number, exact = true) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined; const raw = Buffer.from(value, 'base64url'); return (exact ? raw.length === bytes : raw.length > bytes) && raw.toString('base64url') === value ? raw : undefined; };

export function isSealed(value: any): value is Sealed {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4 && value.v === 1 && !!part(value.salt, 16) && !!part(value.nonce, 12) && !!part(value.data, TAG, false);
}

// `context` names the record the secret belongs to, so a sealed value moved to another record will not open.
export function seal(presented: string, secret: string, context: string): Sealed {
  const salt = randomBytes(16); const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(presented, salt), nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, salt: salt.toString('base64url'), nonce: nonce.toString('base64url'), data: data.toString('base64url') };
}

// Returns undefined for a wrong token, a different record, or altered data; it never throws and never guesses.
export function unseal(presented: string, sealed: unknown, context: string): string | undefined {
  if (typeof presented !== 'string' || !isSealed(sealed)) return undefined;
  const data = Buffer.from(sealed.data, 'base64url');
  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(presented, Buffer.from(sealed.salt, 'base64url')), Buffer.from(sealed.nonce, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(data.subarray(data.length - TAG));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG)), decipher.final()]).toString('utf8');
  } catch { return undefined; }
}
