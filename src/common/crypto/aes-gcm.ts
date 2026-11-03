import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with a random 96-bit IV: `<iv>.<tag>.<ciphertext>`, each part base64url. Used for
 * Google Drive refresh tokens and partner personal data snapshots (with their own keys).
 */
export function encryptAesGcm(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString(
    'base64url',
  )}`;
}

/** Throws when the value is malformed, the key is wrong or the ciphertext was altered. */
export function decryptAesGcm(value: string, key: Buffer): string {
  const [ivPart, tagPart, encryptedPart] = value.split('.');
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error('Invalid encrypted value');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** A base64 key of exactly 32 bytes, or null when it is missing or has another length. */
export function parseAes256Key(raw: string | undefined | null): Buffer | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const key = Buffer.from(value, 'base64');
  return key.length === 32 ? key : null;
}
