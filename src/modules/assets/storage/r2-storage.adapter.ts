import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import type { ObjectHead, StorageAdapter } from './storage-adapter';

@Injectable()
export class R2StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('R2_BUCKET');
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.getOrThrow<string>('R2_ENDPOINT'),
      credentials: {
        accessKeyId: config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
      },
      forcePathStyle: true,
    });
  }

  async getPresignedPutUrl(
    storageKey: string,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async getPresignedGetUrl(
    storageKey: string,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ResponseContentType: contentType,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async headObject(storageKey: string): Promise<ObjectHead | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          ChecksumMode: 'ENABLED',
        }),
      );
      return {
        sizeBytes: Number(result.ContentLength ?? 0),
        checksumSha256: result.ChecksumSHA256
          ? Buffer.from(result.ChecksumSHA256, 'base64').toString('hex')
          : undefined,
      };
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  readObject(storageKey: string): Readable {
    const stream = this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      }),
    );
    return Readable.from(
      (async function* () {
        const result = await stream;
        if (!result.Body) {
          throw new Error('R2 object body is empty');
        }
        for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
          yield chunk;
        }
      })(),
    );
  }

  async putObject(
    storageKey: string,
    body: Readable | Buffer,
    contentType: string,
    contentLength?: number,
  ): Promise<ObjectHead> {
    const commandInput = {
      Bucket: this.bucket,
      Key: storageKey,
      Body: body,
      ContentType: contentType,
      ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
    };
    await this.client.send(
      new PutObjectCommand(commandInput),
    );
    const result = await this.headObject(storageKey);
    if (!result) {
      throw new Error('Uploaded R2 object was not found');
    }
    return result;
  }

  async copyObject(sourceKey: string, targetKey: string): Promise<ObjectHead> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: targetKey,
        CopySource: `${this.bucket}/${encodeURIComponent(sourceKey)}`,
      }),
    );
    const result = await this.headObject(targetKey);
    if (!result) {
      throw new Error('Copied R2 object was not found');
    }
    return result;
  }

  async deleteObject(storageKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      }),
    );
  }

  private isNotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    if ('name' in error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) {
      return true;
    }
    if ('$metadata' in error && typeof error.$metadata === 'object' && error.$metadata !== null) {
      const metadata = error.$metadata as { httpStatusCode?: number };
      return metadata.httpStatusCode === 404;
    }
    return false;
  }
}
