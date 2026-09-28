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
        fontWeight: 740,
        logoScale: 50,
      }),
    ).toEqual({
      text: 'Brand',
      logoAssetId: '0194f7c2-7a11-7d2a-9b10-123456789abc',
      color: '#FFFFFF',
      fontFamily: 'Arial',
      fontSize: 24,
      fontWeight: 700,
      logoScale: 6,
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

  it('allows watermarks larger than the frame and big fonts', () => {
    const config = normalizeWatermarkConfig({ scale: 2.5, fontSize: 360, logoScale: 0.5 });
    expect(config).toMatchObject({ scale: 2.5, fontSize: 360, logoScale: 0.5 });
    expect(normalizeWatermarkConfig({ scale: 9, fontSize: 9999 })).toMatchObject({
      scale: 3,
      fontSize: 400,
    });
  });
});
