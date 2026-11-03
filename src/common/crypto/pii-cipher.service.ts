import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decryptAesGcm, encryptAesGcm, parseAes256Key } from './aes-gcm';

const DEFAULT_KEY_ID = '1';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;

/**
 * Encrypts partner personal data stored by AG Go (contract snapshots) with AES-256-GCM and its own
 * key, `PARTNER_PII_ENCRYPTION_KEY` (base64, 32 bytes), never the Google token key.
 *
 * The ciphertext carries the id of the key that made it, `<keyId>:<iv>.<tag>.<data>`, so the key
 * can be rotated: give the new key a new `PARTNER_PII_ENCRYPTION_KEY_ID` and keep the old one in
 * `PARTNER_PII_ENCRYPTION_PREVIOUS_KEYS` (`id:base64key,id2:base64key`) until every snapshot made
 * with it is re-encrypted.
 */
@Injectable()
export class PiiCipherService {
  constructor(private readonly config: ConfigService) {}

  encrypt(value: string): string {
    const { id, key } = this.currentKey();
    return `${id}:${encryptAesGcm(value, key)}`;
  }

  decrypt(value: string): string {
    const separator = value.indexOf(':');
    if (separator <= 0) {
      throw new Error('Invalid encrypted value');
    }
    const id = value.slice(0, separator);
    const key = this.keys().get(id);
    if (!key) {
      throw new ServiceUnavailableException(`Partner data key "${id}" is not configured`);
    }
    return decryptAesGcm(value.slice(separator + 1), key);
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(value: string): T {
    return JSON.parse(this.decrypt(value)) as T;
  }

  private currentKey(): { id: string; key: Buffer } {
    const id = this.currentKeyId();
    const key = this.keys().get(id);
    if (!key) {
      throw new ServiceUnavailableException(
        'Partner data encryption is not configured (PARTNER_PII_ENCRYPTION_KEY, 32 bytes base64)',
      );
    }
    return { id, key };
  }

  private currentKeyId(): string {
    return this.config.get<string>('PARTNER_PII_ENCRYPTION_KEY_ID')?.trim() || DEFAULT_KEY_ID;
  }

  private keys(): Map<string, Buffer> {
    const keys = new Map<string, Buffer>();
    const previous = this.config.get<string>('PARTNER_PII_ENCRYPTION_PREVIOUS_KEYS')?.trim();
    for (const entry of previous ? previous.split(',') : []) {
      const separator = entry.indexOf(':');
      const id = entry.slice(0, separator).trim();
      const key = parseAes256Key(entry.slice(separator + 1));
      if (separator > 0 && KEY_ID_PATTERN.test(id) && key) {
        keys.set(id, key);
      }
    }
    const current = parseAes256Key(this.config.get<string>('PARTNER_PII_ENCRYPTION_KEY'));
    if (current) {
      keys.set(this.currentKeyId(), current);
    }
    return keys;
  }
}
