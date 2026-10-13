import { ForbiddenException } from '@nestjs/common';
import type { StorageAdapter, UploadedPart } from '../assets/storage/storage-adapter';
import type { SignOp, SignResult } from './farm/sign';

/** A write op (put or multipart) of a farm sign request. */
export type WriteSignOp = Exclude<SignOp, { op: 'get' }>;

/**
 * Signs or runs one write op of a farm worker under `prefix` (the job's folder). The caller has
 * already checked that the output path is allowed for the job.
 */
export async function signWriteOp(
  storage: StorageAdapter,
  op: WriteSignOp,
  prefix: string,
  ttl: number,
  expiresAt: string,
): Promise<SignResult> {
  const output = op.output;
  const key = `${prefix}${output}`;

  if (op.op === 'put') {
    const url = await storage.getPresignedPutUrl(key, op.content_type, ttl);
    return {
      op: 'put',
      output,
      url,
      expires_at: expiresAt,
      headers: { 'Content-Type': op.content_type },
    };
  }

  if (op.op === 'mp_create') {
    const uploadId = await storage.createMultipartUpload(key, op.content_type);
    return { op: 'mp_create', output, upload_id: uploadId };
  }

  if (op.op === 'mp_part_urls') {
    const urls = await Promise.all(
      op.parts.map(async (partNumber) => ({
        part_number: partNumber,
        url: await storage.getPresignedUploadPartUrl(key, op.upload_id, partNumber, ttl),
      })),
    );
    return { op: 'mp_part_urls', output, upload_id: op.upload_id, expires_at: expiresAt, urls };
  }

  if (op.op === 'mp_complete') {
    const parts: UploadedPart[] = op.parts.map((p) => ({
      partNumber: p.part_number,
      etag: p.etag,
      sizeBytes: 0,
    }));
    await storage.completeMultipartUpload(key, op.upload_id, parts);
    return { op: 'mp_complete', output };
  }

  if (op.op === 'mp_abort') {
    await storage.abortMultipartUpload(key, op.upload_id);
    return { op: 'mp_abort', output };
  }

  throw new ForbiddenException(`Unknown sign op: ${(op as { op: string }).op}`);
}

/** A relative path that stays inside the job's folder: no empty, `.` or `..` segment, no `\`. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes('..') || path.includes('\\')) return false;
  const segments = path.split('/');
  return !segments.some((s) => s === '' || s === '.' || s === '..');
}

export function guessContentType(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.mp4') || path.endsWith('.m4v')) return 'video/mp4';
  if (path.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}
