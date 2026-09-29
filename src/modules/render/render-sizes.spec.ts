import {
  comparePreviews,
  describePreview,
  isPreviewVariantCode,
  legacyWidthToResolution,
  normalizeRenderSizes,
  normalizeRenderVariants,
  pickPreviewVariant,
  planPreviewVariants,
  previewVariantCode,
  scaleToShortEdge,
  variantResolution,
} from './render-sizes';

const fallback = { previewWidth: 1920, thumbnailWidth: 320 };

describe('normalizeRenderVariants', () => {
  it('sorts, de-duplicates and drops invalid variants', () => {
    expect(
      normalizeRenderVariants([
        { resolution: 1080, watermark: false },
        { resolution: 720, watermark: true },
        { resolution: 720, watermark: false },
        { resolution: 720, watermark: true },
        { resolution: 100, watermark: true },
        { resolution: 99999, watermark: false },
        { resolution: 480.5, watermark: false },
        { resolution: 480 },
        null,
      ]),
    ).toEqual([
      { resolution: 720, watermark: false },
      { resolution: 720, watermark: true },
      { resolution: 1080, watermark: false },
    ]);
  });

  it('keeps at most eight variants', () => {
    const many = [240, 360, 480, 540, 720, 900, 1080, 1440, 2160].map((resolution) => ({
      resolution,
      watermark: true,
    }));
    expect(normalizeRenderVariants(many)).toHaveLength(8);
  });
});

describe('normalizeRenderSizes', () => {
  it('reads variants', () => {
    expect(
      normalizeRenderSizes(
        {
          maxWidth: null,
          watermarkEnabled: true,
          renderSizes: {
            variants: [
              { resolution: 1080, watermark: false },
              { resolution: 720, watermark: true },
            ],
            thumbnailWidth: 240,
          },
        },
        fallback,
      ),
    ).toEqual({
      variants: [
        { resolution: 720, watermark: true },
        { resolution: 1080, watermark: false },
      ],
      thumbnailWidth: 240,
    });
  });

  it('turns legacy widths into short edges with the profile watermark switch', () => {
    expect(
      normalizeRenderSizes(
        {
          maxWidth: null,
          watermarkEnabled: false,
          renderSizes: { previewWidths: [1920, 480, 1280, 10], thumbnailWidth: 200 },
        },
        fallback,
      ),
    ).toEqual({
      variants: [
        { resolution: 270, watermark: false },
        { resolution: 720, watermark: false },
        { resolution: 1080, watermark: false },
      ],
      thumbnailWidth: 200,
    });
  });

  it('falls back to the legacy max width, then to the environment', () => {
    expect(
      normalizeRenderSizes({ maxWidth: 1280, watermarkEnabled: true, renderSizes: {} }, fallback),
    ).toEqual({ variants: [{ resolution: 720, watermark: true }], thumbnailWidth: 320 });
    expect(normalizeRenderSizes(null, fallback)).toEqual({
      variants: [{ resolution: 1080, watermark: true }],
      thumbnailWidth: 320,
    });
  });
});

describe('legacyWidthToResolution', () => {
  it('maps the usual 16:9 widths and estimates the rest', () => {
    expect(legacyWidthToResolution(3840)).toBe(2160);
    expect(legacyWidthToResolution(854)).toBe(480);
    expect(legacyWidthToResolution(1000)).toBe(563);
    expect(legacyWidthToResolution(64)).toBe(144);
  });
});

describe('scaleToShortEdge', () => {
  it('scales the short edge of landscape and portrait frames', () => {
    expect(scaleToShortEdge(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(scaleToShortEdge(1080, 1920, 720)).toEqual({ width: 720, height: 1280 });
  });

  it('rounds to even sides for video', () => {
    expect(scaleToShortEdge(1000, 750, 481, true)).toEqual({ width: 640, height: 480 });
  });
});

describe('planPreviewVariants', () => {
  const variants = [
    { resolution: 720, watermark: true },
    { resolution: 1080, watermark: false },
  ];

  it('plans every variant with its own watermark', () => {
    expect(planPreviewVariants(3840, 2160, variants, true)).toEqual([
      {
        variantCode: 'preview_720p_wm',
        resolution: 720,
        watermark: true,
        width: 1280,
        height: 720,
      },
      {
        variantCode: 'preview_1080p',
        resolution: 1080,
        watermark: false,
        width: 1920,
        height: 1080,
      },
    ]);
  });

  it('never upscales: larger variants take the source short edge', () => {
    expect(
      planPreviewVariants(1080, 1920, variants, true).map((plan) => [
        plan.variantCode,
        plan.width,
        plan.height,
      ]),
    ).toEqual([
      ['preview_720p_wm', 720, 1280],
      ['preview_1080p', 1080, 1920],
    ]);
    expect(planPreviewVariants(640, 360, variants, true).map((plan) => plan.variantCode)).toEqual([
      'preview_360p',
      'preview_360p_wm',
    ]);
  });

  it('renders variants that end up identical once', () => {
    expect(
      planPreviewVariants(
        640,
        360,
        [
          { resolution: 720, watermark: true },
          { resolution: 1080, watermark: true },
        ],
        true,
      ).map((plan) => plan.variantCode),
    ).toEqual(['preview_360p_wm']);
  });

  it('drops the watermark when the profile has none to draw', () => {
    expect(
      planPreviewVariants(1920, 1080, variants, false).map((plan) => plan.variantCode),
    ).toEqual(['preview_720p', 'preview_1080p']);
  });
});

describe('preview variant codes', () => {
  it('names previews by short edge and watermark, and recognises legacy codes', () => {
    expect(previewVariantCode(720, true)).toBe('preview_720p_wm');
    expect(previewVariantCode(1080, false)).toBe('preview_1080p');
    expect(isPreviewVariantCode('preview_720p_wm')).toBe(true);
    expect(isPreviewVariantCode('preview_1080p')).toBe(true);
    expect(isPreviewVariantCode('preview_960')).toBe(true);
    expect(isPreviewVariantCode('preview')).toBe(true);
    expect(isPreviewVariantCode('thumbnail')).toBe(false);
    expect(isPreviewVariantCode('preview_wm')).toBe(false);
    expect(isPreviewVariantCode('preview_720_wm')).toBe(false);
  });
});

describe('variantResolution', () => {
  it('is the short edge', () => {
    expect(variantResolution({ width: 720, height: 1280 })).toBe(720);
    expect(variantResolution({ width: 1920, height: 1080 })).toBe(1080);
    expect(variantResolution({ width: 480, height: null })).toBe(480);
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

  it('prefers the watermarked preview of the same width', () => {
    const both = [
      { width: 1280, hasWatermark: false },
      { width: 1280, hasWatermark: true },
      { width: 640, hasWatermark: false },
    ];
    expect(pickPreviewVariant(both)).toEqual({ width: 1280, hasWatermark: true });
    expect(pickPreviewVariant(both, 1000)).toEqual({ width: 1280, hasWatermark: true });
  });
});

describe('describePreview', () => {
  const variant = {
    variantCode: 'preview_720p_wm',
    width: 1280,
    height: 720,
    hasWatermark: true,
    mimeType: 'video/mp4',
    fileSizeBytes: '2500000',
  };

  it('adds the short edge and the average bitrate of videos', () => {
    expect(describePreview(variant, 10)).toEqual({
      ...variant,
      resolution: 720,
      bitrateBps: 2_000_000,
    });
  });

  it('has no bitrate for images or without a duration', () => {
    expect(describePreview({ ...variant, mimeType: 'image/webp' }, 10).bitrateBps).toBeNull();
    expect(describePreview(variant, null).bitrateBps).toBeNull();
  });
});

describe('comparePreviews', () => {
  it('sorts by short edge, then un-watermarked first', () => {
    const previews = [
      { width: 1920, height: 1080, hasWatermark: false },
      { width: 1280, height: 720, hasWatermark: true },
      { width: 1280, height: 720, hasWatermark: false },
    ];
    expect([...previews].sort(comparePreviews)).toEqual([previews[2], previews[1], previews[0]]);
  });
});
