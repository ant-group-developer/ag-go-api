import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import 'dotenv/config';
import { Client } from 'pg';

/**
 * Read-only audit of where the bucket's bytes go, compared with what the statistics count
 * (`assets.file_size_bytes` + ready `asset_variants` of assets attached to a project).
 *
 *   yarn r2:storage-audit
 *   yarn r2:storage-audit --top 30     # also list the 30 largest unaccounted objects
 *
 * Lists every object and every open multipart upload, then sorts each byte into one bucket of
 * the report. Nothing is written or deleted.
 */

type Bucket = { objects: number; bytes: number };

type AssetRow = { id: string; key: string; dbBytes: string; linked: boolean };
type VariantRow = { key: string; status: string; linked: boolean };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} B = ${(bytes / 1e12).toFixed(3)} TB = ${(bytes / 1024 ** 4).toFixed(3)} TiB`;
}

async function loadDatabase() {
  const client = new Client({ connectionString: requireEnv('DATABASE_URL') });
  await client.connect();
  try {
    const schema = process.env.DATABASE_SCHEMA;
    if (schema) {
      await client.query(`SET search_path TO "${schema.replace(/"/g, '')}"`);
    }
    const assets = (
      await client.query<AssetRow>(
        `SELECT a.id, a.original_storage_key AS key, a.file_size_bytes::text AS "dbBytes",
                EXISTS (SELECT 1 FROM project_media pm WHERE pm.asset_id = a.id) AS linked
         FROM assets a`,
      )
    ).rows;
    const variants = (
      await client.query<VariantRow>(
        `SELECT v.storage_key AS key, v.status,
                EXISTS (SELECT 1 FROM project_media pm WHERE pm.asset_id = v.asset_id) AS linked
         FROM asset_variants v`,
      )
    ).rows;
    const projectIds = new Set(
      (await client.query<{ id: string }>('SELECT id FROM projects')).rows.map((row) => row.id),
    );
    // What the statistics page shows for an admin: distinct assets attached to any project.
    const stats = (
      await client.query<{ original: string; rendered: string }>(
        `WITH linked AS (SELECT DISTINCT asset_id FROM project_media)
         SELECT
           COALESCE((SELECT SUM(a.file_size_bytes) FROM assets a JOIN linked l ON l.asset_id = a.id), 0)::text AS original,
           COALESCE((SELECT SUM(v.file_size_bytes) FROM asset_variants v JOIN linked l ON l.asset_id = v.asset_id
                     WHERE v.status = 'ready'), 0)::text AS rendered`,
      )
    ).rows[0];
    return { assets, variants, projectIds, stats };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const topIndex = process.argv.indexOf('--top');
  const top = topIndex >= 0 ? Number(process.argv[topIndex + 1]) : 0;
  const bucketName = requireEnv('R2_BUCKET');
  const s3 = new S3Client({
    region: 'auto',
    endpoint: requireEnv('R2_ENDPOINT'),
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: true,
  });

  console.log(`Loading database rows...`);
  const db = await loadDatabase();
  const originalsByKey = new Map<string, AssetRow[]>();
  for (const asset of db.assets) {
    originalsByKey.set(asset.key, [...(originalsByKey.get(asset.key) ?? []), asset]);
  }
  const variantsByKey = new Map(db.variants.map((variant) => [variant.key, variant]));

  const report = new Map<string, Bucket>();
  const add = (name: string, bytes: number) => {
    const entry = report.get(name) ?? { objects: 0, bytes: 0 };
    entry.objects += 1;
    entry.bytes += bytes;
    report.set(name, entry);
  };
  const unaccounted: Array<{ key: string; bytes: number; reason: string }> = [];
  let sizeDrift = 0;
  let total = 0;
  let objects = 0;

  console.log(`Listing bucket "${bucketName}"...`);
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key ?? '';
      const bytes = object.Size ?? 0;
      total += bytes;
      objects += 1;
      const reason = classify(key, bytes);
      add(reason, bytes);
      if (!reason.startsWith('counted')) {
        unaccounted.push({ key, bytes, reason });
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (objects % 50_000 < 1000) {
      process.stdout.write(`  ${objects.toLocaleString('en-US')} objects\r`);
    }
  } while (token);

  function classify(key: string, bytes: number): string {
    const originals = originalsByKey.get(key);
    if (originals) {
      const linked = originals.some((asset) => asset.linked);
      if (!linked) return 'orphan: original of an asset in no project (media removed)';
      sizeDrift += bytes - Number(originals.find((asset) => asset.linked)?.dbBytes ?? 0);
      return 'counted: original';
    }
    const variant = variantsByKey.get(key);
    if (variant) {
      if (!variant.linked) return 'orphan: variant of an asset in no project (media removed)';
      if (variant.status !== 'ready') return `uncounted: variant with status "${variant.status}"`;
      return 'counted: rendered variant';
    }
    const project = /^projects\/([^/]+)\//.exec(key)?.[1];
    if (project && !db.projectIds.has(project)) return 'orphan: under a deleted project';
    // Before DOWNLOAD_ZIP_PREFIX, ZIPs were packed under the project; no lifecycle rule covers them.
    if (/^projects\/[^/]+\/downloads\//.test(key))
      return 'orphan: legacy download ZIPs under projects/*/downloads/';
    if (/\/variants\/[^/]+\/analysis\//.test(key))
      return 'uncounted: analysis artifacts (proxy, keyframes, audio)';
    if (/\/variants\//.test(key)) return 'orphan: variant file with no asset_variants row';
    if (/\/originals\//.test(key)) return 'orphan: original with no assets row (abandoned upload)';
    if (key.startsWith('downloads/')) return 'uncounted: download ZIPs';
    if (key.startsWith('contract-')) return 'uncounted: contract documents/templates';
    if (key.startsWith('settings/')) return 'uncounted: settings (watermark logos)';
    if (key.startsWith('assets/')) return 'orphan: legacy assets/ prefix with no row';
    return `uncounted: other (${key.split('/')[0]}/)`;
  }

  console.log(`Listing open multipart uploads...`);
  let multipartUploads = 0;
  let multipartBytes = 0;
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: bucketName,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    for (const upload of page.Uploads ?? []) {
      multipartUploads += 1;
      let partMarker: string | undefined;
      do {
        const parts = await s3.send(
          new ListPartsCommand({
            Bucket: bucketName,
            Key: upload.Key,
            UploadId: upload.UploadId,
            PartNumberMarker: partMarker,
          }),
        );
        multipartBytes += (parts.Parts ?? []).reduce((sum, part) => sum + (part.Size ?? 0), 0);
        partMarker = parts.IsTruncated ? parts.NextPartNumberMarker : undefined;
      } while (partMarker);
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker);

  const statsOriginal = Number(db.stats.original);
  const statsRendered = Number(db.stats.rendered);
  console.log('\n=== Statistics page (admin scope) ===');
  console.log(`Original: ${formatBytes(statsOriginal)}`);
  console.log(`Rendered: ${formatBytes(statsRendered)}`);
  console.log(`Total:    ${formatBytes(statsOriginal + statsRendered)}`);
  console.log('\n=== Bucket ===');
  console.log(`Objects:  ${objects.toLocaleString('en-US')}`);
  console.log(`Total:    ${formatBytes(total)}`);
  console.log(
    `Open multipart uploads: ${multipartUploads} (${formatBytes(multipartBytes)}), not in the object list`,
  );
  console.log(`Originals: R2 size minus DB file_size_bytes: ${formatBytes(sizeDrift)}`);
  console.log('\n=== Where the bytes are ===');
  for (const [name, entry] of [...report.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(
      `${name}\n    ${entry.objects.toLocaleString('en-US')} objects, ${formatBytes(entry.bytes)}`,
    );
  }
  if (top > 0) {
    console.log(`\n=== ${top} largest objects the statistics do not count ===`);
    for (const item of unaccounted.sort((a, b) => b.bytes - a.bytes).slice(0, top)) {
      console.log(`${formatBytes(item.bytes)}  ${item.reason}  ${item.key}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
