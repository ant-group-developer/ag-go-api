import {
  isPreviewVariantCode,
  normalizeRenderSizes,
  pickPreviewVariant,
  previewVariantCode,
  selectPreviewWidths,
} from './render-sizes';

const fallback = { previewWidth: 1920, thumbnailWidth: 320 };

describe('normalizeRenderSizes', () => {
  it('sorts, de-duplicates and clamps configured widths', () => {
    expect(
      normalizeRenderSizes(
        {
          maxWidth: null,
          renderSizes: {
            previewWidths: [1920, 480, 960, 480, 10, 99999, 1.5],
            thumbnailWidth: 240,
          },
        },
        fallback,
      ),
    ).toEqual({ previewWidths: [480, 960, 1920], thumbnailWidth: 240 });
  });

  it('keeps at most six widths', () => {
    expect(
      normalizeRenderSizes(
        {
          maxWidth: null,
          renderSizes: { previewWidths: [100, 200, 300, 400, 500, 600, 700] },
        },
        fallback,
      ).previewWidths,
    ).toEqual([100, 200, 300, 400, 500, 600]);
  });

  it('falls back to the legacy max width, then to the environment', () => {
    expect(normalizeRenderSizes({ maxWidth: 1280, renderSizes: {} }, fallback)).toEqual({
      previewWidths: [1280],
      thumbnailWidth: 320,
    });
    expect(normalizeRenderSizes(null, fallback)).toEqual({
      previewWidths: [1920],
      thumbnailWidth: 320,
    });
  });
});

describe('selectPreviewWidths', () => {
  it('never upscales', () => {
    expect(selectPreviewWidths(2400, [480, 960, 1920])).toEqual([480, 960, 1920]);
    expect(selectPreviewWidths(800, [480, 960, 1920])).toEqual([480]);
  });

  it('renders the source size when every width is larger', () => {
    expect(selectPreviewWidths(300, [480, 960])).toEqual([300]);
  });
});

describe('preview variant codes', () => {
  it('names previews by width and recognises the legacy code', () => {
    expect(previewVariantCode(960)).toBe('preview_960');
    expect(isPreviewVariantCode('preview_960')).toBe(true);
    expect(isPreviewVariantCode('preview')).toBe(true);
    expect(isPreviewVariantCode('thumbnail')).toBe(false);
    expect(isPreviewVariantCode('preview_720p')).toBe(false);
  });
});

describe('pickPreviewVariant', () => {
  const variants = [{ width: 1920 }, { width: 480 }, { width: 960 }];

  it('picks the smallest preview at least as wide as the frame', () => {
    expect(pickPreviewVariant(variants, 500)).toEqual({ width: 960 });
    expect(pickPreviewVariant(variants, 480)).toEqual({ width: 480 });
  });

  it('falls back to the largest', () => {
    expect(pickPreviewVariant(variants, 4000)).toEqual({ width: 1920 });
    expect(pickPreviewVariant(variants)).toEqual({ width: 1920 });
    expect(pickPreviewVariant([], 100)).toBeUndefined();
  });
});
