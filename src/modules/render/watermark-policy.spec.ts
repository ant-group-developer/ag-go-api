import { isVariantServable, isWatermarkActive } from './watermark-policy';

describe('watermark policy', () => {
  const active = { watermarkEnabled: true, watermarkConfig: { text: 'AG Go' } };
  const logoOnly = {
    watermarkEnabled: true,
    watermarkConfig: { text: '', logoAssetId: '0194f7c2-7a11-7d2a-9b10-123456789abc' },
  };
  const empty = { watermarkEnabled: true, watermarkConfig: { text: '  ' } };
  const disabled = { watermarkEnabled: false, watermarkConfig: { text: 'AG Go' } };

  it('is active only when enabled with text or a logo', () => {
    expect(isWatermarkActive(active)).toBe(true);
    expect(isWatermarkActive(logoOnly)).toBe(true);
    expect(isWatermarkActive(empty)).toBe(false);
    expect(isWatermarkActive(disabled)).toBe(false);
    expect(isWatermarkActive(null)).toBe(false);
  });

  it('serves only watermarked variants while watermarking is active', () => {
    expect(isVariantServable({ hasWatermark: true }, active)).toBe(true);
    expect(isVariantServable({ hasWatermark: false }, active)).toBe(false);
  });

  it('always serves thumbnails, which are never watermarked', () => {
    expect(isVariantServable({ hasWatermark: false, variantCode: 'thumbnail' }, active)).toBe(true);
    expect(isVariantServable({ hasWatermark: false, variantCode: 'preview_960' }, active)).toBe(
      false,
    );
  });

  it('serves any ready variant while watermarking is off', () => {
    expect(isVariantServable({ hasWatermark: false }, disabled)).toBe(true);
    expect(isVariantServable({ hasWatermark: false }, null)).toBe(true);
  });
});
