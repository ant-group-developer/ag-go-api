import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { AssetAnalysisEntity } from '../../../database/entities/asset-analysis.entity';
import type { AssetPrepFarmJobEntity } from '../../../database/entities/asset-prep-farm-job.entity';
import type { AssetPrepEntity } from '../../../database/entities/asset-prep.entity';
import type { AssetVariantEntity } from '../../../database/entities/asset-variant.entity';
import type { AssetEntity } from '../../../database/entities/asset.entity';
import type { StorageAdapter } from '../../assets/storage/storage-adapter';
import type { SystemLogService } from '../../logs/system-log.service';
import type { SignOp } from '../farm/sign';
import type { TicketClaims } from '../farm/ticket';
import { PrepSignService } from './prep-sign.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const PREP_ID = '22222222-2222-7222-8222-222222222222';
const PREFIX = `projects/p1/variants/${ASSET_ID}/prep/${PREP_ID}/`;

function job(type: string): AssetPrepFarmJobEntity {
  return {
    farmJobId: '33333333-3333-4333-8333-333333333333',
    prepId: PREP_ID,
    type,
    status: 'submitted',
    error: null,
    submittedAt: new Date(),
    ingestedAt: null,
    lockedUntil: null,
  };
}

function variant(
  code: string,
  width: number,
  height: number,
  extra: Partial<AssetVariantEntity> = {},
): AssetVariantEntity {
  return {
    id: `v-${code}`,
    assetId: ASSET_ID,
    variantCode: code,
    storageKey: `projects/p1/variants/${ASSET_ID}/${code}.mp4`,
    mimeType: 'video/mp4',
    fileSizeBytes: '1000',
    width,
    height,
    hasWatermark: false,
    status: 'ready',
    updatedAt: new Date(0),
    ...extra,
  } as AssetVariantEntity;
}

function makeService(options: {
  variants?: AssetVariantEntity[];
  analysis?: { id: string } | null;
  missing?: string[];
  sourceMetadata?: Record<string, unknown>;
}) {
  const prepRepo = {
    findOne: jest.fn().mockResolvedValue({ id: PREP_ID, assetId: ASSET_ID }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const asset = {
    id: ASSET_ID,
    assetType: 'video',
    originalStorageKey: `projects/p1/originals/${ASSET_ID}/clip.mp4`,
    mimeType: 'video/mp4',
    fileSizeBytes: '5000',
    checksumSha256: 'abc',
    sourceMetadata: options.sourceMetadata ?? { width: 1920, height: 1080 },
  };
  const storage = {
    headObject: jest.fn(async (key: string) =>
      options.missing?.includes(key) ? null : { sizeBytes: 10 },
    ),
    getPresignedGetUrl: jest.fn(async (key: string) => `https://r2.test/${key}`),
    getPresignedPutUrl: jest.fn(async (key: string) => `https://r2.test/put/${key}`),
  };
  const systemLog = { write: jest.fn().mockResolvedValue(undefined) };
  const service = new PrepSignService(
    prepRepo as unknown as Repository<AssetPrepEntity>,
    { findOne: jest.fn().mockResolvedValue(asset) } as unknown as Repository<AssetEntity>,
    {
      find: jest.fn().mockResolvedValue(options.variants ?? []),
    } as unknown as Repository<AssetVariantEntity>,
    {
      findOne: jest.fn().mockResolvedValue(options.analysis ?? null),
    } as unknown as Repository<AssetAnalysisEntity>,
    storage as unknown as StorageAdapter,
    { get: () => undefined } as unknown as ConfigService,
    systemLog as unknown as SystemLogService,
  );
  return { service, prepRepo, storage, systemLog };
}

const claims = { job_id: 'j', type: 'scan.prep' } as TicketClaims;

describe('PrepSignService.authorizeOp', () => {
  const { service } = makeService({});
  const put = (output: string): SignOp => ({ op: 'put', output, content_type: 'image/jpeg' });

  it('lets scan.prep read the source and write frames, sheets, prep.json and audio.wav', () => {
    for (const op of [
      { op: 'get', input: 'source' } as SignOp,
      put('frames/001.jpg'),
      put('sheets/01.jpg'),
      put('prep.json'),
      { op: 'mp_create', output: 'audio.wav', content_type: 'audio/wav' } as SignOp,
    ]) {
      expect(() => service.authorizeOp(op, job('scan.prep'))).not.toThrow();
    }
  });

  it('refuses anything else for scan.prep', () => {
    for (const op of [
      put('transcribe.json'),
      put('frames/a/b.jpg'),
      put('other.txt'),
      { op: 'get', input: 'artifact:audio.wav' } as SignOp,
    ]) {
      expect(() => service.authorizeOp(op, job('scan.prep'))).toThrow(ForbiddenException);
    }
  });

  it('lets studio.transcribe read audio.wav and write transcribe.json only', () => {
    expect(() =>
      service.authorizeOp({ op: 'get', input: 'artifact:audio.wav' }, job('studio.transcribe')),
    ).not.toThrow();
    expect(() =>
      service.authorizeOp(put('transcribe.json'), job('studio.transcribe')),
    ).not.toThrow();
    expect(() =>
      service.authorizeOp({ op: 'get', input: 'source' }, job('studio.transcribe')),
    ).toThrow(ForbiddenException);
    expect(() => service.authorizeOp(put('prep.json'), job('studio.transcribe'))).toThrow(
      ForbiddenException,
    );
  });
});

describe('PrepSignService source', () => {
  const getSource = async (service: PrepSignService) => {
    const { results } = await service.sign(claims, job('scan.prep'), [
      { op: 'get', input: 'source' },
    ]);
    return results[0] as Extract<(typeof results)[0], { op: 'get' }>;
  };

  it('reads the smallest clean rendition at least 480 px high', async () => {
    const { service, prepRepo } = makeService({
      variants: [
        variant('preview_360p', 640, 360),
        variant('preview_540p', 960, 540),
        variant('preview_720p', 1280, 720),
        variant('preview_480p', 854, 480, { hasWatermark: true }),
      ],
      analysis: { id: 'a1' },
    });
    const source = await getSource(service);
    expect(source.url).toContain('preview_540p');
    expect(source.source).toMatchObject({ source_kind: 'preview', watermarked: false });
    expect(prepRepo.update).toHaveBeenCalledWith(PREP_ID, {
      sourceKind: 'preview',
      watermarked: false,
    });
  });

  it('falls back to the analysis proxy, then to the original', async () => {
    const withProxy = makeService({
      variants: [variant('preview_360p', 640, 360)],
      analysis: { id: 'a1' },
    });
    expect((await getSource(withProxy.service)).source?.source_kind).toBe('proxy');

    const proxyMissing = makeService({
      analysis: { id: 'a1' },
      missing: [`projects/p1/variants/${ASSET_ID}/analysis/a1/proxy.mp4`],
    });
    expect((await getSource(proxyMissing.service)).source?.source_kind).toBe('original');
  });

  it('signs writes under the prep folder and logs only notable requests', async () => {
    const { service, systemLog } = makeService({});
    const { results } = await service.sign(claims, job('scan.prep'), [
      { op: 'put', output: 'frames/001.jpg', content_type: 'image/jpeg' },
    ]);
    expect(results[0]).toMatchObject({
      op: 'put',
      url: `https://r2.test/put/${PREFIX}frames/001.jpg`,
    });
    expect(systemLog.write).not.toHaveBeenCalled();

    await service.sign(claims, job('scan.prep'), [
      { op: 'put', output: 'prep.json', content_type: 'application/json' },
    ]);
    expect(systemLog.write).toHaveBeenCalledTimes(1);
  });
});
