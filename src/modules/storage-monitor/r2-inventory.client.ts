import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ListedObject = { key: string; bytes: number };

/**
 * Lists the whole bucket for the storage audit. Kept apart from the StorageAdapter: only the
 * audit lists, and a full listing is not something the rest of the app should reach for.
 */
@Injectable()
export class R2InventoryClient {
  readonly bucket: string;
  private readonly client: S3Client;

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

  /** Every object, a page of up to 1000 at a time. */
  async *listObjectPages(): AsyncGenerator<ListedObject[]> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token, MaxKeys: 1000 }),
      );
      yield (page.Contents ?? []).map((object) => ({
        key: object.Key ?? '',
        bytes: object.Size ?? 0,
      }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  /** Multipart uploads still open and the bytes their parts hold (not in the object listing). */
  async openMultipartUploads(): Promise<{ uploads: number; bytes: number }> {
    let uploads = 0;
    let bytes = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );
      for (const upload of page.Uploads ?? []) {
        uploads += 1;
        let partMarker: string | undefined;
        do {
          const parts = await this.client.send(
            new ListPartsCommand({
              Bucket: this.bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
              PartNumberMarker: partMarker,
            }),
          );
          bytes += (parts.Parts ?? []).reduce((sum, part) => sum + (part.Size ?? 0), 0);
          partMarker = parts.IsTruncated ? parts.NextPartNumberMarker : undefined;
        } while (partMarker);
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
    } while (keyMarker);
    return { uploads, bytes };
  }
}
