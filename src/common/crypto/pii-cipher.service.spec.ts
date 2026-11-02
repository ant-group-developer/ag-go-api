import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { decryptAesGcm, encryptAesGcm, parseAes256Key } from './aes-gcm';
import { PiiCipherService } from './pii-cipher.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

describe('aes-gcm', () => {
  it('round-trips with a random IV and refuses an altered ciphertext', () => {
    const key = parseAes256Key(KEY_A)!;
    const first = encryptAesGcm('035086000130', key);
    const second = encryptAesGcm('035086000130', key);

    expect(first).not.toEqual(second);
    expect(first.split('.')).toHaveLength(3);
    expect(decryptAesGcm(first, key)).toBe('035086000130');

    const [iv, tag, data] = first.split('.');
    const bytes = Buffer.from(data, 'base64url');
    bytes[0] ^= 0xff;
    const altered = `${iv}.${tag}.${bytes.toString('base64url')}`;
    expect(() => decryptAesGcm(altered, key)).toThrow();
    expect(() => decryptAesGcm(first, parseAes256Key(KEY_B)!)).toThrow();
    expect(() => decryptAesGcm('not-encrypted', key)).toThrow('Invalid encrypted value');
  });

  it('only accepts 32-byte base64 keys', () => {
    expect(parseAes256Key(KEY_A)).toHaveLength(32);
    expect(parseAes256Key(randomBytes(16).toString('base64'))).toBeNull();
    expect(parseAes256Key('')).toBeNull();
    expect(parseAes256Key(undefined)).toBeNull();
  });
});

describe('PiiCipherService', () => {
  it('prefixes the ciphertext with the key id and decrypts JSON', () => {
    const cipher = new PiiCipherService(config({ PARTNER_PII_ENCRYPTION_KEY: KEY_A }));
    const encrypted = cipher.encryptJson({ citizenIdNumber: '035086000130' });

    expect(encrypted.startsWith('1:')).toBe(true);
    expect(encrypted).not.toContain('035086000130');
    expect(cipher.decryptJson(encrypted)).toEqual({ citizenIdNumber: '035086000130' });
  });

  it('still decrypts snapshots of a previous key after a rotation', () => {
    const before = new PiiCipherService(config({ PARTNER_PII_ENCRYPTION_KEY: KEY_A }));
    const old = before.encrypt('secret');

    const after = new PiiCipherService(
      config({
        PARTNER_PII_ENCRYPTION_KEY: KEY_B,
        PARTNER_PII_ENCRYPTION_KEY_ID: '2',
        PARTNER_PII_ENCRYPTION_PREVIOUS_KEYS: `1:${KEY_A}`,
      }),
    );

    expect(after.decrypt(old)).toBe('secret');
    expect(after.encrypt('new').startsWith('2:')).toBe(true);
  });

  it('refuses to encrypt without a valid key, and a value of an unknown key', () => {
    expect(() => new PiiCipherService(config({})).encrypt('x')).toThrow(
      ServiceUnavailableException,
    );
    expect(() =>
      new PiiCipherService(
        config({ PARTNER_PII_ENCRYPTION_KEY: randomBytes(16).toString('base64') }),
      ).encrypt('x'),
    ).toThrow(ServiceUnavailableException);

    const other = new PiiCipherService(
      config({ PARTNER_PII_ENCRYPTION_KEY: KEY_A, PARTNER_PII_ENCRYPTION_KEY_ID: 'k9' }),
    ).encrypt('x');
    expect(() =>
      new PiiCipherService(config({ PARTNER_PII_ENCRYPTION_KEY: KEY_A })).decrypt(other),
    ).toThrow(ServiceUnavailableException);
  });
});
