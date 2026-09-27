import type { EntityManager } from 'typeorm';
import {
  assetVariantsPrefix,
  deleteAssetsAndRefreshBatches,
  planProjectAssetCleanup,
} from './project-asset-cleanup';

const PROJECT = 'p-deleted';
const PREFIX = `projects/${PROJECT}/`;

type Row = { id: string; originalStorageKey: string; shared: boolean; originalShared: boolean };

/** A manager answering the asset query with `assets`, the variant query with `variants`. */
function managerWith(assets: Row[], variants: Array<{ assetId: string; storageKey: string }> = []) {
  const query = jest.fn(async (sql: string) =>
    sql.includes('FROM asset_variants') ? variants : assets,
  );
  return { manager: { query } as unknown as EntityManager, query };
}

describe('assetVariantsPrefix', () => {
  it('uses the project folder of the original, or the asset folder', () => {
    expect(assetVariantsPrefix('projects/a/originals/x.jpg', 'id1')).toBe(
      'projects/a/variants/id1/',
    );
    expect(assetVariantsPrefix('uploads/x.jpg', 'id1')).toBe('assets/id1/variants/id1/');
  });
});

describe('planProjectAssetCleanup', () => {
  it('keeps a shared asset under the prefix and protects its objects from the purge', async () => {
    const { manager } = managerWith(
      [
        {
          id: 'a1',
          originalStorageKey: `${PREFIX}originals/a1.jpg`,
          shared: true,
          originalShared: false,
        },
      ],
      [{ assetId: 'a1', storageKey: `${PREFIX}variants/a1/preview.webp` }],
    );

    const plan = await planProjectAssetCleanup(manager, PROJECT, PREFIX);

    expect(plan.removableAssetIds).toEqual([]);
    expect(plan.keepPrefixes).toEqual([
      `${PREFIX}originals/a1.jpg`,
      `${PREFIX}variants/a1/`,
      `${PREFIX}variants/a1/preview.webp`,
    ]);
    expect(plan.extraPurgePrefixes).toEqual([]);
  });

  it('removes an unshared asset stored under another (deleted) project and purges its objects', async () => {
    const { manager } = managerWith([
      {
        id: 'a2',
        originalStorageKey: 'projects/p-old/originals/a2.mp4',
        shared: false,
        originalShared: false,
      },
    ]);

    const plan = await planProjectAssetCleanup(manager, PROJECT, PREFIX);

    expect(plan.removableAssetIds).toEqual(['a2']);
    expect(plan.keepPrefixes).toEqual([]);
    expect(plan.extraPurgePrefixes).toEqual([
      'projects/p-old/originals/a2.mp4',
      'projects/p-old/variants/a2/',
    ]);
  });

  it('keeps an original object another asset still points at', async () => {
    const { manager } = managerWith([
      {
        id: 'a3',
        originalStorageKey: 'projects/p-old/originals/same.jpg',
        shared: false,
        originalShared: true,
      },
    ]);

    const plan = await planProjectAssetCleanup(manager, PROJECT, PREFIX);

    expect(plan.removableAssetIds).toEqual(['a3']);
    expect(plan.extraPurgePrefixes).toEqual(['projects/p-old/variants/a3/']);
  });

  it('leaves an unshared asset under the prefix to the project purge', async () => {
    const { manager } = managerWith([
      {
        id: 'a4',
        originalStorageKey: `${PREFIX}originals/a4.jpg`,
        shared: false,
        originalShared: false,
      },
    ]);

    const plan = await planProjectAssetCleanup(manager, PROJECT, PREFIX);

    expect(plan).toEqual({ removableAssetIds: ['a4'], keepPrefixes: [], extraPurgePrefixes: [] });
  });
});

describe('deleteAssetsAndRefreshBatches', () => {
  it('does nothing without assets', async () => {
    const { manager, query } = managerWith([]);

    await deleteAssetsAndRefreshBatches(manager, []);

    expect(query).not.toHaveBeenCalled();
  });
});
