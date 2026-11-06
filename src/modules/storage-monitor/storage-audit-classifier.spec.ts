import {
  classifyStorageKey,
  topLevelPrefix,
  type StorageKeyLookup,
} from './storage-audit-classifier';

const PROJECT = '01a0d233-073c-75f1-92e1-0436d8fadaa7';
const GONE_PROJECT = '01a0d313-769f-76d1-8282-7a55d2e4f401';
const ASSET = '01a114f8-8006-75cc-922e-a296d338859e';
const REMOVED_ASSET = '01a11495-0e07-75e9-8f69-49830f85109a';
const GONE_ASSET = '01a114fc-ccc5-767b-baaa-1c069509ccd8';

function lookup(overrides: Partial<StorageKeyLookup> = {}): StorageKeyLookup {
  return {
    originals: new Map(),
    variants: new Map(),
    projectIds: new Set([PROJECT]),
    assets: new Map([
      [ASSET, { linked: true }],
      [REMOVED_ASSET, { linked: false }],
    ]),
    ...overrides,
  };
}

describe('classifyStorageKey', () => {
  it('classifies recorded originals by whether a project still uses them', () => {
    const key = `projects/${PROJECT}/originals/${ASSET}.mp4`;
    expect(classifyStorageKey(key, lookup({ originals: new Map([[key, { linked: true }]]) }))).toBe(
      'original',
    );
    expect(
      classifyStorageKey(key, lookup({ originals: new Map([[key, { linked: false }]]) })),
    ).toBe('removed_media');
  });

  it('classifies recorded variants by attachment and status', () => {
    const key = `projects/${PROJECT}/variants/${ASSET}/preview.mp4`;
    const variants = (linked: boolean, status: string) => new Map([[key, { linked, status }]]);
    expect(classifyStorageKey(key, lookup({ variants: variants(true, 'ready') }))).toBe('variant');
    expect(classifyStorageKey(key, lookup({ variants: variants(true, 'failed') }))).toBe(
      'variant_not_ready',
    );
    expect(classifyStorageKey(key, lookup({ variants: variants(false, 'ready') }))).toBe(
      'removed_media',
    );
  });

  it('puts every object of a deleted project in deleted_project', () => {
    expect(classifyStorageKey(`projects/${GONE_PROJECT}/originals/x.mp4`, lookup())).toBe(
      'deleted_project',
    );
    expect(classifyStorageKey(`projects/${GONE_PROJECT}/downloads/u/z.zip`, lookup())).toBe(
      'deleted_project',
    );
  });

  it('flags ZIPs left under a live project by the old download layout', () => {
    expect(classifyStorageKey(`projects/${PROJECT}/downloads/user/job.zip`, lookup())).toBe(
      'legacy_project_zip',
    );
  });

  it('sorts unrecorded files under an asset variants folder by the asset', () => {
    const prefix = `projects/${PROJECT}/variants`;
    expect(classifyStorageKey(`${prefix}/${ASSET}/analysis/a1/proxy.mp4`, lookup())).toBe(
      'analysis',
    );
    expect(classifyStorageKey(`${prefix}/${ASSET}/old-preview.mp4`, lookup())).toBe(
      'variant_untracked',
    );
    expect(classifyStorageKey(`${prefix}/${REMOVED_ASSET}/analysis/a1/proxy.mp4`, lookup())).toBe(
      'removed_media',
    );
    expect(classifyStorageKey(`${prefix}/${GONE_ASSET}/thumbnail.webp`, lookup())).toBe(
      'deleted_asset',
    );
    expect(classifyStorageKey(`assets/${GONE_ASSET}/variants/${GONE_ASSET}/x.webp`, lookup())).toBe(
      'deleted_asset',
    );
  });

  it('recognises the other prefixes the app writes', () => {
    expect(classifyStorageKey(`projects/${PROJECT}/originals/abandoned.mp4`, lookup())).toBe(
      'original_untracked',
    );
    expect(classifyStorageKey('downloads/user/job.zip', lookup())).toBe('download_zip');
    expect(classifyStorageKey('contract-documents/c/a-1/signed-1.pdf', lookup())).toBe('documents');
    expect(classifyStorageKey('contract-templates/x/all/v1-1.docx', lookup())).toBe('documents');
    expect(classifyStorageKey('settings/watermark/logo.png', lookup())).toBe('settings');
  });

  it('leaves keys the app never writes in other', () => {
    expect(classifyStorageKey('backup/dump.tar', lookup())).toBe('other');
    expect(classifyStorageKey('movie.mkv', lookup())).toBe('other');
  });
});

describe('topLevelPrefix', () => {
  it('returns the first folder, or (root) for a key without one', () => {
    expect(topLevelPrefix('backup/2026/dump.tar')).toBe('backup/');
    expect(topLevelPrefix('movie.mkv')).toBe('(root)');
  });
});
