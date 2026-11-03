import type { StorageAdapter } from '../assets/storage/storage-adapter';

/** Whole object in memory (templates and documents are a few hundred KB). */
export async function readObjectBuffer(storage: StorageAdapter, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of storage.readObject(key)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
