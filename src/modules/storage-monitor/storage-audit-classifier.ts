import { DOWNLOAD_ZIP_PREFIX } from '../downloads/download-naming';
import type { StorageAuditCategory } from './storage-monitor.types';

/** What the database says about the keys of one listed page (see StorageAuditService.lookUp). */
export type StorageKeyLookup = {
  /** Original keys of `assets`, with whether one of those assets is attached to a project. */
  originals: Map<string, { linked: boolean }>;
  variants: Map<string, { linked: boolean; status: string }>;
  /** Ids of the projects named by `projects/<id>/` keys that still exist. */
  projectIds: Set<string>;
  /** Assets named by `variants/<assetId>/` keys that still exist, with whether they are attached. */
  assets: Map<string, { linked: boolean }>;
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROJECT_KEY = new RegExp(`^projects/(${UUID})/`, 'i');
const VARIANT_KEY = new RegExp(`/variants/(${UUID})/`, 'i');
const ANALYSIS_KEY = new RegExp(`/variants/${UUID}/analysis/`, 'i');
// Before DOWNLOAD_ZIP_PREFIX, ZIPs were packed under the project; no lifecycle rule covers them.
const LEGACY_PROJECT_ZIP_KEY = /^projects\/[^/]+\/downloads\//;

export function projectIdOfKey(key: string): string | null {
  return PROJECT_KEY.exec(key)?.[1]?.toLowerCase() ?? null;
}

export function variantAssetIdOfKey(key: string): string | null {
  return VARIANT_KEY.exec(key)?.[1]?.toLowerCase() ?? null;
}

/**
 * Sorts one object into the category the audit reports. Database rows win over key patterns:
 * a key the database records is classified by its row wherever it is stored.
 */
export function classifyStorageKey(key: string, lookup: StorageKeyLookup): StorageAuditCategory {
  const original = lookup.originals.get(key);
  if (original) {
    return original.linked ? 'original' : 'removed_media';
  }
  const variant = lookup.variants.get(key);
  if (variant) {
    if (!variant.linked) return 'removed_media';
    return variant.status === 'ready' ? 'variant' : 'variant_not_ready';
  }

  const projectId = projectIdOfKey(key);
  if (projectId && !lookup.projectIds.has(projectId)) return 'deleted_project';
  if (LEGACY_PROJECT_ZIP_KEY.test(key)) return 'legacy_project_zip';

  const assetId = variantAssetIdOfKey(key);
  if (assetId) {
    const asset = lookup.assets.get(assetId);
    if (!asset) return 'deleted_asset';
    if (!asset.linked) return 'removed_media';
    return ANALYSIS_KEY.test(key) ? 'analysis' : 'variant_untracked';
  }
  if (key.includes('/originals/')) return 'original_untracked';

  if (key.startsWith(DOWNLOAD_ZIP_PREFIX)) return 'download_zip';
  if (key.startsWith('contract-documents/') || key.startsWith('contract-templates/')) {
    return 'documents';
  }
  if (key.startsWith('settings/')) return 'settings';
  return 'other';
}

/** Top-level folder of a key, used to break the `other` category down. */
export function topLevelPrefix(key: string): string {
  const slash = key.indexOf('/');
  return slash < 0 ? '(root)' : `${key.slice(0, slash)}/`;
}
