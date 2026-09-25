import { DEFAULT_WATERMARK_CONFIG, normalizeWatermarkConfig } from './watermark-config';

describe('normalizeWatermarkConfig', () => {
  it('fills defaults for legacy or empty configurations', () => {
    expect(normalizeWatermarkConfig({})).toEqual(DEFAULT_WATERMARK_CONFIG);
  });

  it('clamps numeric values and keeps supported fields', () => {
    expect(
      normalizeWatermarkConfig({
        text: 'Brand',
        logoAssetId: '0194f7c2-7a11-7d2a-9b10-123456789abc',
        position: 'top-left',
        opacity: 2,
        scale: 0,
        margin: 999,
      }),
    ).toEqual({
      text: 'Brand',
      logoAssetId: '0194f7c2-7a11-7d2a-9b10-123456789abc',
      color: '#FFFFFF',
      fontFamily: 'Arial',
      fontSize: 24,
      repeat: false,
      gapX: 220,
      gapY: 100,
      rotate: 0,
      maxWidth: null,
      position: 'top-left',
      opacity: 1,
      scale: 0.05,
      margin: 500,
    });
  });
});
