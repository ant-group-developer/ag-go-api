export const MEDIA_PROCESSING_QUEUE = 'media-processing';
export const MEDIA_PROCESSING_JOB = 'asset-processing';
export const DOWNLOAD_QUEUE = 'downloads';
export const DOWNLOAD_JOB = 'download-zip';
export const IMPORT_QUEUE = 'google-drive-imports';
export const IMPORT_JOB = 'google-drive-import';
export const IMPORT_DISCOVERY_QUEUE = 'google-drive-import-discovery';
export const IMPORT_DISCOVERY_JOB = 'google-drive-import-discovery';

/** Keep up to 1000 failed jobs for at most 7 days so Redis does not grow unbounded. */
export const DEFAULT_FAILED_JOB_RETENTION = {
  count: 1000,
  age: 7 * 24 * 3600,
} as const;
