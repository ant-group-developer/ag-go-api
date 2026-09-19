import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ObjectHead, StorageAdapter } from './storage-adapter';

@Injectable()
export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(config: ConfigService) {
    const configuredRoot = config.get<string>('LOCAL_STORAGE_ROOT', '.data/storage');
    this.root = isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(process.cwd(), configuredRoot);
  }

  async writeObject(storageKey: string, input: Readable): Promise<ObjectHead> {
    const path = this.resolvePath(storageKey);
    await mkdir(resolve(path, '..'), { recursive: true });
    await pipeline(input, createWriteStream(path, { flags: 'w' }));
    return this.headObject(storageKey) as Promise<ObjectHead>;
  }

  async headObject(storageKey: string): Promise<ObjectHead | null> {
    const path = this.resolvePath(storageKey);
    try {
      const metadata = await stat(path);
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      for await (const chunk of stream) {
        hash.update(chunk);
      }
      return {
        sizeBytes: metadata.size,
        checksumSha256: hash.digest('hex'),
      };
    } catch (error) {
      if (this.isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

  readObject(storageKey: string): Readable {
    return createReadStream(this.resolvePath(storageKey));
  }

  async copyObject(sourceKey: string, targetKey: string): Promise<ObjectHead> {
    const sourcePath = this.resolvePath(sourceKey);
    const targetPath = this.resolvePath(targetKey);
    await mkdir(resolve(targetPath, '..'), { recursive: true });
    await copyFile(sourcePath, targetPath);
    return this.headObject(targetKey) as Promise<ObjectHead>;
  }

  async deleteObject(storageKey: string): Promise<void> {
    await rm(this.resolvePath(storageKey), { force: true });
  }

  private resolvePath(storageKey: string): string {
    const path = resolve(join(this.root, storageKey));
    const relativePath = relative(this.root, path);
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
      throw new Error('Invalid storage key');
    }
    return path;
  }

  private isMissingFile(error: unknown): boolean {
    return (
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
  }
}
