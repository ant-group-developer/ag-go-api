import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import type { ObjectHead, StorageAdapter, UploadedPart } from './storage-adapter';

/** Parts in flight hold QUEUE_SIZE x PART_BYTES of memory per stream upload. */
const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
const MULTIPART_QUEUE_SIZE = 4;

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

  async getObjectText(storageKey: string): Promise<string> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      }),
    );
    if (!result.Body) {
      throw new Error(`R2 object body is empty: ${storageKey}`);
    }
    return result.Body.transformToString('utf-8');
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
    if (body instanceof Readable) {
      // Multipart: a single PUT caps at 5 GB and must finish within one request.
      await new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: storageKey, Body: body, ContentType: contentType },
        partSize: MULTIPART_PART_BYTES,
        queueSize: MULTIPART_QUEUE_SIZE,
        leavePartsOnError: false,
      }).done();
    } else {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Body: body,
          ContentType: contentType,
          ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
        }),
      );
    }
    const result = await this.headObject(storageKey);
    if (!result) {
      throw new Error('Uploaded R2 object was not found');
    }
    if (contentLength !== undefined && result.sizeBytes !== contentLength) {
      await this.deleteObject(storageKey);
      throw new Error(
        `Uploaded R2 object is ${result.sizeBytes} bytes, expected ${contentLength} bytes`,
      );
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

  async deletePrefix(prefix: string, keep?: (storageKey: string) => boolean): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;
    do {
      // A listing page holds at most 1000 keys, which is also the DeleteObjects batch limit.
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (page.Contents ?? []).flatMap((object) =>
        object.Key && !keep?.(object.Key) ? [object.Key] : [],
      );
      if (keys.length > 0) {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const failed = result.Errors ?? [];
        if (failed.length > 0) {
          throw new Error(
            `R2 could not delete ${failed.length} object(s) under ${prefix}: ${failed[0]?.Key} (${failed[0]?.Code})`,
          );
        }
        deleted += keys.length;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key && upload.UploadId && !keep?.(upload.Key)) {
          await this.abortMultipartUpload(upload.Key, upload.UploadId);
        }
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
    } while (keyMarker);
    return deleted;
  }

  async createMultipartUpload(storageKey: string, contentType: string): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('R2 did not return a multipart upload id');
    }
    return result.UploadId;
  }

  async getPresignedUploadPartUrl(
    storageKey: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: storageKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async listMultipartParts(storageKey: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: storageKey,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        if (part.PartNumber !== undefined && part.ETag) {
          parts.push({
            partNumber: part.PartNumber,
            etag: part.ETag,
            sizeBytes: Number(part.Size ?? 0),
          });
        }
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(
    storageKey: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: storageKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(storageKey: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: storageKey,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }
    }
  }

  private isNotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    if (
      'name' in error &&
      (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.name === 'NoSuchUpload')
    ) {
      return true;
    }
    if ('$metadata' in error && typeof error.$metadata === 'object' && error.$metadata !== null) {
      const metadata = error.$metadata as { httpStatusCode?: number };
      return metadata.httpStatusCode === 404;
    }
    return false;
  }
}
