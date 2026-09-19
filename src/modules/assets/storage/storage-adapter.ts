import type { Readable } from 'node:stream';

export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

export type ObjectHead = {
  sizeBytes: number;
  checksumSha256: string;
};

export interface StorageAdapter {
  writeObject(storageKey: string, input: Readable): Promise<ObjectHead>;
  headObject(storageKey: string): Promise<ObjectHead | null>;
  readObject(storageKey: string): Readable;
  copyObject(sourceKey: string, targetKey: string): Promise<ObjectHead>;
  deleteObject(storageKey: string): Promise<void>;
}
