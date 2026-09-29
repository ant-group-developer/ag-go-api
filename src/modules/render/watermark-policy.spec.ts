import {
  canViewUnwatermarked,
  isVariantServable,
  isWatermarkActive,
  watermarkFingerprint,
} from './watermark-policy';

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

  it('serves un-watermarked previews to viewers allowed to see originals', () => {
    expect(isVariantServable({ hasWatermark: false }, active, true)).toBe(true);
  });

  it('lets admins and users who evaluate or download originals see un-watermarked media', () => {
    expect(canViewUnwatermarked([], 'ADMIN')).toBe(true);
    expect(canViewUnwatermarked(['go.project.evaluate'], 'USER')).toBe(true);
    expect(canViewUnwatermarked(['go.project.download_original'], 'USER')).toBe(true);
    expect(canViewUnwatermarked(['go.project.read', 'go.project.download_rendered'], 'USER')).toBe(
      false,
    );
    expect(canViewUnwatermarked(undefined, undefined)).toBe(false);
  });

  it('fingerprints the watermark look, not the switch', () => {
    expect(watermarkFingerprint(active)).toBe(watermarkFingerprint(disabled));
    expect(watermarkFingerprint(active)).not.toBe(watermarkFingerprint(logoOnly));
    expect(watermarkFingerprint(active)).toMatch(/^[0-9a-f]{12}$/);
  });
});
