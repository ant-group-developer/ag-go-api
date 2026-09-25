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
  /** Starts a multipart upload the browser fills part by part; returns its upload id. */
  createMultipartUpload(storageKey: string, contentType: string): Promise<string>;
  getPresignedUploadPartUrl(
    storageKey: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string>;
  listMultipartParts(storageKey: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(
    storageKey: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void>;
  /** Discards the uploaded parts; an upload that is already completed or aborted is ignored. */
  abortMultipartUpload(storageKey: string, uploadId: string): Promise<void>;
}

export type UploadedPart = {
  partNumber: number;
  etag: string;
  sizeBytes: number;
};
