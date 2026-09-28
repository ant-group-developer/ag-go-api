import type { ConfigService } from '@nestjs/config';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { Repository } from 'typeorm';
import type { AssetEntity } from '../../database/entities/asset.entity';
import type { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { MediaProcessingService } from './media-processing.service';
import type { StorageAdapter } from './storage/storage-adapter';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

type Watermark = { buffer: Buffer; width: number; height: number; top: number; left: number };

const LOGO_ID = '0194f7c2-7a11-7d2a-9b10-123456789abc';

// Logo-only watermarks keep these tests independent of the fonts installed on the machine.
async function createService(logoAvailable = true) {
  const logo = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const assetRepository = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        logoAvailable
          ? { id: LOGO_ID, originalStorageKey: 'logo.png', mimeType: 'image/png' }
          : null,
      ),
  } as unknown as Repository<AssetEntity>;
  const storage = {
    readObject: jest.fn(() => Readable.from([logo])),
  } as unknown as StorageAdapter;
  const service = new MediaProcessingService(
    assetRepository,
    {} as never,
    {} as never,
    {} as never,
    storage,
    {} as ConfigService,
  );
  return (
    width: number,
    height: number,
    watermarkConfig: Record<string, unknown>,
  ): Promise<Watermark | null> =>
    (
      service as unknown as {
        createWatermark: (
          width: number,
          height: number,
          profile: Partial<RenderProfileEntity>,
        ) => Promise<Watermark | null>;
      }
    ).createWatermark(width, height, {
      watermarkEnabled: true,
      watermarkConfig: { text: '', logoAssetId: LOGO_ID, ...watermarkConfig },
    });
}

describe('MediaProcessingService watermark', () => {
  it('sizes a single watermark from the scale and anchors it with a scaled margin', async () => {
    const createWatermark = await createService();
    const watermark = await createWatermark(1920, 1080, {
      scale: 0.25,
      margin: 24,
      position: 'bottom-right',
    });
    // Antialiased edges of the rasterised tile can shift its measured size by a couple of pixels.
    expect(Math.abs(watermark!.width - 480)).toBeLessThanOrEqual(3);
    expect(Math.abs(watermark!.height - 480)).toBeLessThanOrEqual(3);
    expect(watermark?.left).toBe(1920 - watermark!.width - 48);
    expect(watermark?.top).toBe(1080 - watermark!.height - 48);
  });

  it('keeps the same proportion on thumbnails and previews', async () => {
    const createWatermark = await createService();
    const thumbnail = await createWatermark(320, 180, { scale: 0.25 });
    const preview = await createWatermark(1920, 1080, { scale: 0.25 });
    expect(thumbnail!.width / 320).toBeCloseTo(preview!.width / 1920, 2);
  });

  it('crops a watermark larger than the frame instead of shrinking it', async () => {
    const createWatermark = await createService();
    const watermark = await createWatermark(1000, 200, {
      scale: 1,
      margin: 0,
      position: 'bottom-right',
    });
    // The 1000px square logo keeps its size; only the bottom 200px fit in the frame.
    expect(watermark?.height).toBe(200);
    expect(watermark?.top).toBe(0);
    expect(Math.abs(watermark!.width - 1000)).toBeLessThanOrEqual(3);
    const stats = await sharp(watermark!.buffer).stats();
    expect(stats.channels[3].max).toBeGreaterThan(0);
  });

  it('resizes the logo with logoScale on top of the watermark size', async () => {
    const createWatermark = await createService();
    const watermark = await createWatermark(1920, 1080, { scale: 0.1, logoScale: 2 });
    expect(Math.abs(watermark!.width - 384)).toBeLessThanOrEqual(3);
  });

  it('keeps a small logo on whole pixels so its edges stay sharp', async () => {
    const createWatermark = await createService();
    for (const [width, height] of [
      [320, 180],
      [427, 240],
    ]) {
      const watermark = await createWatermark(width, height, { scale: 0.1, opacity: 1 });
      const stats = await sharp(watermark!.buffer).stats();
      // A logo straddling pixel rows would leave half-transparent edge rows.
      expect(stats.channels[3].min).toBe(255);
    }
  });

  it('rotates without growing a blurred fringe', async () => {
    const createWatermark = await createService();
    const watermark = await createWatermark(960, 540, { scale: 0.1, opacity: 1, rotate: 90 });
    const stats = await sharp(watermark!.buffer).stats();
    expect(watermark!.width).toBe(watermark!.height);
    expect(stats.channels[3].min).toBe(255);
  });

  it('applies the opacity to the logo', async () => {
    const createWatermark = await createService();
    const watermark = await createWatermark(960, 540, { opacity: 0.5 });
    const stats = await sharp(watermark!.buffer).stats();
    expect(stats.channels[3].max).toBeGreaterThan(120);
    expect(stats.channels[3].max).toBeLessThan(135);
  });

  it('covers the whole frame from the origin when repeated', async () => {
    const createWatermark = await createService();
    const watermark = await createWatermark(1280, 720, {
      repeat: true,
      position: 'bottom-right',
      margin: 40,
    });
    expect(watermark).toMatchObject({ width: 1280, height: 720, top: 0, left: 0 });
    const stats = await sharp(watermark!.buffer).stats();
    expect(stats.channels[3].max).toBeGreaterThan(0);
  });

  it('repeats tiles larger than a small frame without failing', async () => {
    const createWatermark = await createService();
    await expect(
      createWatermark(40, 30, { repeat: true, fontSize: 240, rotate: 30 }),
    ).resolves.toMatchObject({ width: 40, height: 30 });
  });

  it('fails instead of marking an empty render as watermarked', async () => {
    const createWatermark = await createService(false);
    await expect(createWatermark(960, 540, {})).rejects.toThrow(
      'Watermark logo could not be loaded',
    );
  });

  it('returns null when the profile has nothing to draw', async () => {
    const createWatermark = await createService();
    await expect(createWatermark(960, 540, { logoAssetId: null })).resolves.toBeNull();
  });
});

describe('MediaProcessingService image variants', () => {
  type SavedVariant = {
    variantCode: string;
    width: number;
    height: number;
    hasWatermark: boolean;
    storageKey: string;
  };

  async function renderImage(sourceWidth: number, sourceHeight: number) {
    const logo = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const source = await sharp({
      create: {
        width: sourceWidth,
        height: sourceHeight,
        channels: 3,
        background: { r: 20, g: 80, b: 160 },
      },
    })
      .jpeg()
      .toBuffer();
    const saved: SavedVariant[] = [];
    const deleted: string[] = [];
    const variantRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: SavedVariant) => value),
      save: jest.fn(async (value: SavedVariant) => {
        saved.push(value);
        return value;
      }),
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 'legacy', variantCode: 'preview', storageKey: 'legacy/preview.webp' },
        ]),
      delete: jest.fn(),
    };
    const storage = {
      readObject: jest.fn(() => Readable.from([logo])),
      putObject: jest.fn(async (_key: string, body: Buffer) => ({ sizeBytes: body.length })),
      deleteObject: jest.fn(async (key: string) => {
        deleted.push(key);
      }),
    };
    const service = new MediaProcessingService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: LOGO_ID,
          originalStorageKey: 'logo.png',
          mimeType: 'image/png',
        }),
      } as never,
      variantRepository as never,
      {} as never,
      {} as never,
      storage as never,
      { getOrThrow: () => 1920 } as unknown as ConfigService,
    );
    await (
      service as unknown as {
        processImage: (
          asset: unknown,
          input: Buffer,
          profile: unknown,
          report: () => Promise<void>,
        ) => Promise<unknown>;
      }
    ).processImage(
      { id: 'asset-1', originalStorageKey: 'projects/p1/originals/a.jpg' },
      source,
      {
        id: 'profile',
        profileVersion: 2,
        imageQuality: 80,
        maxWidth: null,
        watermarkEnabled: true,
        watermarkConfig: { text: '', logoAssetId: LOGO_ID },
        renderSizes: { previewWidths: [480, 960, 1920], thumbnailWidth: 200 },
      },
      async () => undefined,
    );
    return { saved, deleted, variantRepository };
  }

  it('renders every configured width that fits, with the height following the ratio', async () => {
    const { saved } = await renderImage(1200, 800);
    const previews = saved.filter((variant) => variant.variantCode.startsWith('preview_'));
    expect(previews.map((variant) => [variant.variantCode, variant.width, variant.height])).toEqual(
      [
        ['preview_480', 480, 320],
        ['preview_960', 960, 640],
      ],
    );
    expect(previews.every((variant) => variant.hasWatermark)).toBe(true);
  });

  it('renders a small thumbnail without watermark', async () => {
    const { saved } = await renderImage(1200, 800);
    expect(saved.find((variant) => variant.variantCode === 'thumbnail')).toMatchObject({
      width: 200,
      height: 133,
      hasWatermark: false,
    });
  });

  it('renders the source size when it is smaller than every width', async () => {
    const { saved } = await renderImage(300, 200);
    expect(
      saved.filter((variant) => variant.variantCode.startsWith('preview_')).map((v) => v.width),
    ).toEqual([300]);
  });

  it('deletes variants the new render did not produce', async () => {
    const { deleted, variantRepository } = await renderImage(1200, 800);
    expect(deleted).toEqual(['legacy/preview.webp']);
    expect(variantRepository.delete).toHaveBeenCalledWith('legacy');
  });
});

describe('MediaProcessingService video variants', () => {
  type SavedVariant = { variantCode: string; width: number; height: number; hasWatermark: boolean };
  const settings: Record<string, number> = {
    MEDIA_FFMPEG_THREADS: 2,
    MEDIA_RENDER_TIMEOUT_SECONDS: 60,
    MEDIA_PREVIEW_MAX_WIDTH: 1920,
    MEDIA_THUMBNAIL_MAX_WIDTH: 320,
  };
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'media-video-spec-'));
    source = join(dir, 'source.mp4');
    const { default: ffmpegPath } = await import('ffmpeg-static');
    const { execFileSync } = await import('node:child_process');
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      source,
    ]);
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('renders every preview size in a single FFmpeg run', async () => {
    const logo = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const saved: SavedVariant[] = [];
    const uploaded = new Map<string, number>();
    const storage = {
      readObject: jest.fn(() => Readable.from([logo])),
      putObject: jest.fn(async (key: string, body: Buffer | Readable) => {
        let size = 0;
        for await (const chunk of Buffer.isBuffer(body) ? [body] : body) {
          size += (chunk as Buffer).length;
        }
        uploaded.set(key, size);
        return { sizeBytes: size };
      }),
    };
    const service = new MediaProcessingService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: LOGO_ID,
          originalStorageKey: 'logo.png',
          mimeType: 'image/png',
        }),
      } as never,
      {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((value: SavedVariant) => value),
        save: jest.fn(async (value: SavedVariant) => saved.push(value)),
        find: jest.fn().mockResolvedValue([]),
      } as never,
      {} as never,
      {} as never,
      storage as never,
      { getOrThrow: (key: string) => settings[key] } as unknown as ConfigService,
    );
    const internals = service as unknown as {
      runProcess: (...args: unknown[]) => Promise<unknown>;
      processVideo: (
        asset: unknown,
        input: string,
        profile: unknown,
        report: () => Promise<void>,
      ) => Promise<{ width?: number; height?: number }>;
    };
    const runProcess = jest.spyOn(internals, 'runProcess');

    const metadata = await internals.processVideo(
      { id: 'asset-1', originalStorageKey: 'projects/p1/originals/a.mp4' },
      source,
      {
        id: 'profile',
        profileVersion: 2,
        watermarkEnabled: true,
        watermarkConfig: { text: '', logoAssetId: LOGO_ID },
        renderSizes: { previewWidths: [160, 320, 640], thumbnailWidth: 120 },
      },
      async () => undefined,
    );

    expect(metadata).toMatchObject({ width: 640, height: 360 });
    const previews = saved.filter((variant) => variant.variantCode.startsWith('preview_'));
    expect(previews.map((variant) => [variant.variantCode, variant.width, variant.height])).toEqual(
      [
        ['preview_160', 160, 90],
        ['preview_320', 320, 180],
        ['preview_640', 640, 360],
      ],
    );
    expect(previews.every((variant) => variant.hasWatermark)).toBe(true);
    for (const width of [160, 320, 640]) {
      expect(uploaded.get(`projects/p1/variants/asset-1/preview_${width}.mp4`)).toBeGreaterThan(0);
    }
    // ffprobe, the thumbnail frame, then one run for all previews.
    expect(runProcess).toHaveBeenCalledTimes(3);
  }, 60_000);
});

describe('MediaProcessingService runProcess', () => {
  type RunProcess = (
    command: string,
    args: string[],
    options: { timeoutMs?: number; stallMs?: number; onProgress?: (seconds: number) => void },
  ) => Promise<{ stdout: string; stderr: string }>;

  // Stands in for `ffmpeg -progress pipe:1`: one report block per tick, then `progress=end`.
  function fakeFfmpeg(ticks: number, thenHang = false): string[] {
    return [
      '-e',
      `let frame = 0;
      const timer = setInterval(() => {
        frame += 1;
        process.stdout.write('frame=' + frame + '\\nout_time_us=' + frame * 100000 + '\\nprogress=continue\\n');
        if (frame === ${ticks}) {
          clearInterval(timer);
          if (${thenHang}) { setInterval(() => undefined, 1000); } else { process.stdout.write('progress=end\\n'); }
        }
      }, 20);`,
    ];
  }

  const runProcess = () => {
    const service = new MediaProcessingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getOrThrow: () => 60 } as unknown as ConfigService,
    );
    return (service as unknown as { runProcess: RunProcess }).runProcess.bind(service);
  };

  it('keeps a command running while its position advances, reporting each position', async () => {
    const positions: number[] = [];
    await runProcess()(process.execPath, fakeFfmpeg(20), {
      stallMs: 300,
      onProgress: (seconds) => positions.push(seconds),
    });
    expect(positions).toHaveLength(20);
    expect(positions.at(-1)).toBeCloseTo(2);
  });

  it('kills a command whose position stops advancing', async () => {
    await expect(
      runProcess()(process.execPath, fakeFfmpeg(3, true), { stallMs: 300 }),
    ).rejects.toThrow('Media processing stalled');
  });

  it('still enforces the total limit on a command that keeps advancing', async () => {
    await expect(
      runProcess()(process.execPath, fakeFfmpeg(1000), { stallMs: 300, timeoutMs: 400 }),
    ).rejects.toThrow('Media processing timed out');
  });

  it.each([
    // As cancelSupersededRenderJobs leaves it.
    ['gets cancelled by a newer render of the file', { status: 'cancelled' }],
    // Re-queued as stale by a worker on another host, then claimed by a third one.
    [
      'is claimed by another worker after a stale re-queue',
      { status: 'processing', claimToken: 'other-worker-token' },
    ],
  ])(
    'stops a render whose job %s',
    async (_, currentJob) => {
      const job = { id: 'job-1', assetId: 'asset-1', renderProfileId: null, renderBatchId: null };
      const updateChain = {
        update: () => updateChain,
        set: jest.fn().mockReturnThis(),
        where: () => updateChain,
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const jobRepository = {
        // The lookup, the check before the render starts (still held by this run's claim), then
        // the periodic cancel checks see the job no longer held.
        findOne: jest
          .fn()
          .mockResolvedValueOnce(job)
          .mockResolvedValueOnce({ id: job.id, status: 'processing', claimToken: 'generated-uuid' })
          .mockResolvedValue({ id: job.id, ...currentJob }),
        createQueryBuilder: () => updateChain,
        update: jest.fn(),
      };
      const assetRepository = {
        findOne: jest.fn().mockResolvedValue({
          id: 'asset-1',
          assetType: 'video',
          originalStorageKey: 'projects/p1/originals/a.mp4',
        }),
        update: jest.fn(),
      };
      const service = new MediaProcessingService(
        assetRepository as never,
        {} as never,
        jobRepository as never,
        { findOne: jest.fn().mockResolvedValue(null) } as never,
        {
          headObject: jest.fn().mockResolvedValue({}),
          readObject: jest.fn(() => Readable.from([Buffer.from('source')])),
        } as never,
        { getOrThrow: () => 600 } as unknown as ConfigService,
      );
      const internals = service as unknown as {
        runProcess: RunProcess;
        processVideo: () => Promise<unknown>;
      };
      // A render that would run for about 20 s.
      jest
        .spyOn(internals, 'processVideo')
        .mockImplementation(() =>
          internals.runProcess(process.execPath, fakeFfmpeg(1000), { stallMs: 60_000 }),
        );

      const startedAt = Date.now();
      await expect(service.processJobById(job.id, job.assetId)).resolves.toBeUndefined();

      expect(Date.now() - startedAt).toBeLessThan(10_000);
      // The claim recorded this run's token, which is what the cancel checks compare against.
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'processing', claimToken: 'generated-uuid' }),
      );
      const statuses = jobRepository.update.mock.calls.map(
        ([, values]) => (values as { status?: string }).status,
      );
      expect(statuses).not.toContain('failed');
      expect(statuses).not.toContain('completed');
      expect(assetRepository.update).not.toHaveBeenCalledWith(
        'asset-1',
        expect.objectContaining({ processingStatus: 'failed' }),
      );
    },
    20_000,
  );
});

describe('MediaProcessingService removeLeftoverTempFiles', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes only render temp files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-test-'));
    jest.spyOn(os, 'tmpdir').mockReturnValue(dir);
    for (const name of ['ag-go-asset-1', 'ag-go-preview-a-1920-1.mp4', 'other.txt']) {
      writeFileSync(join(dir, name), 'x');
    }
    const service = new MediaProcessingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    try {
      service.removeLeftoverTempFiles();
      expect(readdirSync(dir)).toEqual(['other.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
