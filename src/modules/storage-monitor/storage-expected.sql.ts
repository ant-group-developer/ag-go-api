import type { ByteCount, ExpectedStorageBreakdown } from './storage-monitor.types';

/**
 * Bytes of every object the database records, by source. One row of `<source>_bytes` /
 * `<source>_objects` pairs (bigints as text). Originals are counted once per key, since several
 * assets can share one stored file. Download ZIPs count while the lifecycle rule
 * (`yarn r2:download-lifecycle`, one day) may still keep them.
 */
export const EXPECTED_STORAGE_SQL = `
WITH linked_assets AS (
  SELECT a.id, a.original_storage_key, a.file_size_bytes,
         EXISTS (SELECT 1 FROM project_media pm WHERE pm.asset_id = a.id) AS linked
  FROM assets a
),
original_keys AS (
  SELECT original_storage_key, MAX(file_size_bytes) AS bytes, bool_or(linked) AS linked
  FROM linked_assets
  GROUP BY original_storage_key
),
variant_rows AS (
  SELECT v.file_size_bytes AS bytes, v.status, la.linked
  FROM asset_variants v
  INNER JOIN linked_assets la ON la.id = v.asset_id
),
document_rows AS (
  SELECT size_bytes AS bytes FROM document_templates
  UNION ALL
  SELECT size_bytes FROM generated_documents WHERE storage_key IS NOT NULL
  UNION ALL
  SELECT pdf_size_bytes FROM generated_documents WHERE pdf_storage_key IS NOT NULL
  UNION ALL
  SELECT proof_size_bytes FROM payments WHERE proof_storage_key IS NOT NULL
)
SELECT
  (SELECT COALESCE(SUM(bytes), 0) FROM original_keys WHERE linked)::text AS originals_bytes,
  (SELECT COUNT(*) FROM original_keys WHERE linked)::text AS originals_objects,
  (SELECT COALESCE(SUM(bytes), 0) FROM variant_rows WHERE linked AND status = 'ready')::text AS variants_bytes,
  (SELECT COUNT(*) FROM variant_rows WHERE linked AND status = 'ready')::text AS variants_objects,
  (SELECT COALESCE(SUM(bytes), 0) FROM variant_rows WHERE linked AND status <> 'ready')::text AS variants_not_ready_bytes,
  (SELECT COUNT(*) FROM variant_rows WHERE linked AND status <> 'ready' AND bytes > 0)::text AS variants_not_ready_objects,
  (SELECT COALESCE(SUM(zip_size_bytes), 0) FROM download_jobs
     WHERE status = 'completed' AND zip_storage_key IS NOT NULL
       AND updated_at > now() - interval '2 days')::text AS downloads_bytes,
  (SELECT COUNT(*) FROM download_jobs
     WHERE status = 'completed' AND zip_storage_key IS NOT NULL
       AND updated_at > now() - interval '2 days')::text AS downloads_objects,
  (SELECT COALESCE(SUM(bytes), 0) FROM document_rows)::text AS documents_bytes,
  (SELECT COUNT(*) FROM document_rows)::text AS documents_objects,
  ((SELECT COALESCE(SUM(bytes), 0) FROM original_keys WHERE NOT linked)
    + (SELECT COALESCE(SUM(bytes), 0) FROM variant_rows WHERE NOT linked))::text AS removed_media_bytes,
  ((SELECT COUNT(*) FROM original_keys WHERE NOT linked)
    + (SELECT COUNT(*) FROM variant_rows WHERE NOT linked))::text AS removed_media_objects`;

export type ExpectedStorageRow = Record<string, string>;

export function toExpectedBreakdown(row: ExpectedStorageRow): ExpectedStorageBreakdown {
  const pair = (source: string): ByteCount => ({
    bytes: Number(row[`${source}_bytes`] ?? 0),
    objects: Number(row[`${source}_objects`] ?? 0),
  });
  return {
    originals: pair('originals'),
    variants: pair('variants'),
    variantsNotReady: pair('variants_not_ready'),
    downloads: pair('downloads'),
    documents: pair('documents'),
    removedMedia: pair('removed_media'),
  };
}

/** What the app is meant to keep; removed media is reported apart, as a known leak. */
export function expectedBytesOf(breakdown: ExpectedStorageBreakdown): number {
  return (
    breakdown.originals.bytes +
    breakdown.variants.bytes +
    breakdown.variantsNotReady.bytes +
    breakdown.downloads.bytes +
    breakdown.documents.bytes
  );
}
