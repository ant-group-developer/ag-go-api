import type { Repository } from 'typeorm';
import type { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import type { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { findRenderedVariant, renderedFilename } from './rendered-variant';

function repositories(
  variants: Array<Partial<AssetVariantEntity>>,
  profile: Partial<RenderProfileEntity> | null,
) {
  return {
    variantRepository: {
      find: jest.fn().mockResolvedValue(variants),
    } as unknown as Repository<AssetVariantEntity>,
    profileRepository: {
      findOne: jest.fn().mockResolvedValue(profile),
    } as unknown as Repository<RenderProfileEntity>,
  };
}

const activeProfile = { watermarkEnabled: true, watermarkConfig: { text: 'AG Go' } };

describe('findRenderedVariant', () => {
  it('picks the largest watermarked preview', async () => {
    const { variantRepository, profileRepository } = repositories(
      [
        { variantCode: 'thumbnail', hasWatermark: false, width: 320 },
        { variantCode: 'preview_1920', hasWatermark: true, width: 1920 },
        { variantCode: 'preview_480', hasWatermark: true, width: 480 },
      ],
      activeProfile,
    );
    await expect(
      findRenderedVariant(variantRepository, profileRepository, 'asset-1'),
    ).resolves.toMatchObject({ variantCode: 'preview_1920' });
  });

  it('still serves a legacy single preview', async () => {
    const { variantRepository, profileRepository } = repositories(
      [{ variantCode: 'preview', hasWatermark: true, width: 1280 }],
      activeProfile,
    );
    await expect(
      findRenderedVariant(variantRepository, profileRepository, 'asset-1'),
    ).resolves.toMatchObject({ variantCode: 'preview' });
  });

  it('skips un-watermarked previews while watermarking is active', async () => {
    const { variantRepository, profileRepository } = repositories(
      [
        { variantCode: 'preview_1920', hasWatermark: false, width: 1920 },
        { variantCode: 'preview_960', hasWatermark: true, width: 960 },
      ],
      activeProfile,
    );
    await expect(
      findRenderedVariant(variantRepository, profileRepository, 'asset-1'),
    ).resolves.toMatchObject({ variantCode: 'preview_960' });
  });

  it('never falls back to the thumbnail or the original', async () => {
    const { variantRepository, profileRepository } = repositories(
      [
        { variantCode: 'preview_960', hasWatermark: false, width: 960 },
        { variantCode: 'thumbnail', hasWatermark: false, width: 320 },
      ],
      activeProfile,
    );
    await expect(
      findRenderedVariant(variantRepository, profileRepository, 'asset-1'),
    ).resolves.toBeNull();
  });
});

describe('renderedFilename', () => {
  it('uses the extension of the rendered variant', () => {
    expect(renderedFilename('photo.JPG', 'image/webp')).toBe('photo.webp');
    expect(renderedFilename('clip.mov', 'video/mp4')).toBe('clip.mp4');
    expect(renderedFilename('noext', 'image/jpeg')).toBe('noext.jpg');
    expect(renderedFilename('file.bin', 'application/octet-stream')).toBe('file.bin');
  });
});
