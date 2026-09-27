import type { EntityManager } from 'typeorm';
import { refreshRenderBatch } from '../render/render-job-lifecycle';

/** Outbox event removing the storage objects of assets deleted outside a project prefix purge. */
export const ASSET_STORAGE_PURGE_EVENT = 'asset.storage.purge';

/** What deleting a project does to the assets it stores or uses. */
export type ProjectAssetCleanup = {
  /** Assets no other project uses: deleted with their render jobs and variants. */
  removableAssetIds: string[];
  /** Objects under the project prefix that other projects still use; the purge keeps them. */
  keepPrefixes: string[];
  /**
   * Objects of removable assets stored outside the project prefix (for example first uploaded
   * to a project deleted earlier, while this one still used them): purged one by one.
   */
  extraPurgePrefixes: string[];
};

type AssetRow = {
  id: string;
  originalStorageKey: string;
  /** Attached to a project other than the one being deleted. */
  shared: boolean;
  /** Another asset points at the same original object, which must then stay. */
  originalShared: boolean;
};

/** Where the renderer writes an asset's variants (see MediaProcessingService.projectPrefix). */
export function assetVariantsPrefix(originalStorageKey: string, assetId: string): string {
  const match = /^projects\/([^/]+)\//.exec(originalStorageKey);
  const prefix = match ? `projects/${match[1]}` : `assets/${assetId}`;
  return `${prefix}/variants/${assetId}/`;
}

/**
 * Plans the asset side of deleting `projectId`: every asset stored under its prefix or attached
 * to it. One still attached to another project stays (with its render jobs, the other project
 * needs its previews); every other one is removed, wherever it is stored, so no orphan asset
 * keeps rendering. Call it before the project row is deleted, while its media rows still exist.
 */
export async function planProjectAssetCleanup(
  manager: EntityManager,
  projectId: string,
  storagePrefix: string,
): Promise<ProjectAssetCleanup> {
  const assets = (await manager.query(
    `SELECT asset.id, asset.original_storage_key AS "originalStorageKey",
       EXISTS (
         SELECT 1 FROM project_media other
         WHERE other.asset_id = asset.id AND other.project_id <> $2
       ) AS shared,
       EXISTS (
         SELECT 1 FROM assets twin
         WHERE twin.original_storage_key = asset.original_storage_key AND twin.id <> asset.id
       ) AS "originalShared"
     FROM assets asset
     WHERE asset.original_storage_key LIKE $1 || '%'
        OR EXISTS (
          SELECT 1 FROM project_media media
          WHERE media.asset_id = asset.id AND media.project_id = $2
        )`,
    [storagePrefix, projectId],
  )) as AssetRow[];
  // Recorded variant keys too, in case older renders wrote them outside the usual prefix.
  const variantRows =
    assets.length > 0
      ? ((await manager.query(
          `SELECT asset_id AS "assetId", storage_key AS "storageKey"
           FROM asset_variants WHERE asset_id = ANY($1::uuid[])`,
          [assets.map((asset) => asset.id)],
        )) as Array<{ assetId: string; storageKey: string }>)
      : [];

  const keepPrefixes: string[] = [];
  const extraPurgePrefixes: string[] = [];
  const removableAssetIds: string[] = [];
  for (const asset of assets) {
    const objects = [
      ...(asset.originalShared && !asset.shared ? [] : [asset.originalStorageKey]),
      assetVariantsPrefix(asset.originalStorageKey, asset.id),
      ...variantRows.filter((row) => row.assetId === asset.id).map((row) => row.storageKey),
    ];
    const inside = objects.filter((key) => key.startsWith(storagePrefix));
    if (asset.shared) {
      // Only objects under the purged prefix need protecting; the others are not touched.
      keepPrefixes.push(...inside);
      continue;
    }
    removableAssetIds.push(asset.id);
    extraPurgePrefixes.push(...objects.filter((key) => !key.startsWith(storagePrefix)));
  }
  return { removableAssetIds, keepPrefixes, extraPurgePrefixes: [...new Set(extraPurgePrefixes)] };
}

/**
 * Deletes `assetIds`; their render jobs and variants go with them (ON DELETE CASCADE). A worker
 * rendering one of those jobs stops at its next cancel check. The batches that held the jobs
 * are recounted, otherwise they would stay `processing` with counters that never move.
 */
export async function deleteAssetsAndRefreshBatches(
  manager: EntityManager,
  assetIds: string[],
): Promise<void> {
  if (assetIds.length === 0) {
    return;
  }
  const batchRows = (await manager.query(
    `SELECT DISTINCT render_batch_id AS "batchId"
     FROM media_render_jobs
     WHERE asset_id = ANY($1::uuid[]) AND render_batch_id IS NOT NULL`,
    [assetIds],
  )) as Array<{ batchId: string }>;
  await manager.query('DELETE FROM assets WHERE id = ANY($1::uuid[])', [assetIds]);
  // In a fixed order, like cancelSupersededRenderJobs, so concurrent refreshes cannot deadlock.
  for (const batchId of batchRows.map((row) => row.batchId).sort()) {
    await refreshRenderBatch(manager, batchId);
  }
}
