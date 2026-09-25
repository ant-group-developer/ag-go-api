import type { Readable } from 'node:stream';

export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

export type ObjectHead = {
  sizeBytes: number;
  checksumSha256?: string;
};

export interface StorageAdapter {
  getPresignedPutUrl(
    storageKey: string,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<string>;
  getPresignedGetUrl(
    storageKey: string,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<string>;
  headObject(storageKey: string): Promise<ObjectHead | null>;
  readObject(storageKey: string): Readable;
  putObject(
    storageKey: string,
    body: Readable | Buffer,
    contentType: string,
    contentLength?: number,
  ): Promise<ObjectHead>;
  copyObject(sourceKey: string, targetKey: string): Promise<ObjectHead>;
  deleteObject(storageKey: string): Promise<void>;
}
