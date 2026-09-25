import type { ConfigService } from '@nestjs/config';
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

  it('shrinks a watermark that would not fit inside the margins', async () => {
    const createWatermark = await createService();
    const watermark = await createWatermark(1000, 200, { scale: 1, margin: 0 });
    expect(watermark?.height).toBeLessThanOrEqual(200);
    expect(watermark?.width).toBeLessThanOrEqual(1000);
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
