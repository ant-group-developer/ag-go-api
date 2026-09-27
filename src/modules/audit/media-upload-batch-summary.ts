/** Audit action of a batch of files uploaded directly (drag and drop / file picker) into a project. */
export const MEDIA_UPLOADED_AUDIT_ACTION = 'media_uploaded';

/** File names kept in the entry; the counters still cover every file of the batch. */
const MAX_LISTED_FILES = 10;

export type UploadedFile = {
  filename: string;
  assetType: 'image' | 'video';
  sizeBytes: number;
};

/** `after_data` of a `media_uploaded` entry, grown by one file each time an upload completes. */
export type MediaUploadBatchSummary = {
  uploadBatchId: string;
  fileCount: number;
  imageCount: number;
  videoCount: number;
  totalBytes: number;
  files: Array<{ name: string; assetType: 'image' | 'video' }>;
  lastUploadedAt: string;
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Adds one completed upload to the batch summary (or starts it from an empty/unknown payload). */
export function addFileToUploadBatchSummary(
  previous: Record<string, unknown> | null | undefined,
  uploadBatchId: string,
  file: UploadedFile,
  uploadedAt: Date,
): MediaUploadBatchSummary {
  const files = Array.isArray(previous?.files)
    ? (previous.files as MediaUploadBatchSummary['files'])
    : [];
  return {
    uploadBatchId,
    fileCount: count(previous?.fileCount) + 1,
    imageCount: count(previous?.imageCount) + (file.assetType === 'image' ? 1 : 0),
    videoCount: count(previous?.videoCount) + (file.assetType === 'video' ? 1 : 0),
    totalBytes: count(previous?.totalBytes) + Math.max(file.sizeBytes, 0),
    files:
      files.length < MAX_LISTED_FILES
        ? [...files, { name: file.filename, assetType: file.assetType }]
        : files,
    lastUploadedAt: uploadedAt.toISOString(),
  };
}
