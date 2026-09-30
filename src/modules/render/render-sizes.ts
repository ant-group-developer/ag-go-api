import type { RenderProfileEntity } from '../../database/entities/render-profile.entity';

/**
 * One preview a render profile produces: `resolution` is the target short edge in pixels
 * ("720p" is 1280x720 landscape and 720x1280 portrait), `watermark` whether it carries the
 * profile's watermark.
 */
export type RenderVariantSpec = {
  resolution: number;
  watermark: boolean;
};

/**
 * Output sizes of a render profile: the preview variants and one thumbnail width. Heights and
 * widths follow the aspect ratio of the file. The thumbnail never carries the watermark.
 */
export type RenderSizes = {
  variants: RenderVariantSpec[];
  thumbnailWidth: number;
};

/** A preview variant planned for one source file. */
export type PlannedPreview = {
  variantCode: string;
  /** Short edge actually rendered: the spec's resolution, or the source's when that is smaller. */
  resolution: number;
  watermark: boolean;
  width: number;
  height: number;
};

export const PREVIEW_RESOLUTION_MIN = 144;
export const PREVIEW_RESOLUTION_MAX = 4320;
export const PREVIEW_VARIANTS_MAX_COUNT = 8;
export const THUMBNAIL_WIDTH_MIN = 64;
export const THUMBNAIL_WIDTH_MAX = 1024;

/** Legacy width-based preview sizes, still stored on profiles saved before variants existed. */
const LEGACY_PREVIEW_WIDTH_MIN = 64;
const LEGACY_PREVIEW_WIDTH_MAX = 7680;

/** Matches `preview_<n>p[_wm]`, the legacy `preview_<width>` and the legacy single `preview`. */
const PREVIEW_VARIANT_PATTERN = /^preview(_\d+(p(_wm)?)?)?$/;

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Short edge of the usual 16:9 frame of a legacy preview width (1920 -> 1080, 1280 -> 720). */
export function legacyWidthToResolution(width: number): number {
  const known: Record<number, number> = {
    3840: 2160,
    2560: 1440,
    1920: 1080,
    1280: 720,
    960: 540,
    854: 480,
    640: 360,
  };
  const resolution = known[width] ?? Math.round((width * 9) / 16);
  return Math.min(PREVIEW_RESOLUTION_MAX, Math.max(PREVIEW_RESOLUTION_MIN, resolution));
}

function compareVariants(a: RenderVariantSpec, b: RenderVariantSpec): number {
  return a.resolution - b.resolution || Number(a.watermark) - Number(b.watermark);
}

/** Valid variants, without duplicates, smallest first (unwatermarked before watermarked). */
export function normalizeRenderVariants(value: unknown): RenderVariantSpec[] {
  const variants = new Map<string, RenderVariantSpec>();
  for (const item of Array.isArray(value) ? value : []) {
    const candidate = item as Partial<RenderVariantSpec> | null;
    if (
      !candidate ||
      !isIntegerBetween(candidate.resolution, PREVIEW_RESOLUTION_MIN, PREVIEW_RESOLUTION_MAX) ||
      typeof candidate.watermark !== 'boolean'
    ) {
      continue;
    }
    const variant = { resolution: candidate.resolution, watermark: candidate.watermark };
    variants.set(`${variant.resolution}:${variant.watermark}`, variant);
  }
  return [...variants.values()].sort(compareVariants).slice(0, PREVIEW_VARIANTS_MAX_COUNT);
}

function legacyVariants(widths: unknown, watermark: boolean): RenderVariantSpec[] {
  const valid = Array.isArray(widths)
    ? widths.filter((width): width is number =>
        isIntegerBetween(width, LEGACY_PREVIEW_WIDTH_MIN, LEGACY_PREVIEW_WIDTH_MAX),
      )
    : [];
  return normalizeRenderVariants(
    valid.map((width) => ({ resolution: legacyWidthToResolution(width), watermark })),
  );
}

/**
 * Sizes of a profile. Profiles saved before variants existed have `previewWidths`, all with the
 * profile's watermark switch; without either, the legacy `max_width` column and then the
 * MEDIA_PREVIEW_MAX_WIDTH / MEDIA_THUMBNAIL_MAX_WIDTH environment values apply.
 */
export function normalizeRenderSizes(
  profile:
    Pick<RenderProfileEntity, 'renderSizes' | 'maxWidth' | 'watermarkEnabled'> | null | undefined,
  fallback: { previewWidth: number; thumbnailWidth: number },
): RenderSizes {
  const raw = profile?.renderSizes ?? {};
  const watermark = profile?.watermarkEnabled ?? true;
  let variants = normalizeRenderVariants(raw.variants);
  if (variants.length === 0) {
    variants = legacyVariants(raw.previewWidths, watermark);
  }
  if (variants.length === 0) {
    variants = legacyVariants([profile?.maxWidth ?? fallback.previewWidth], watermark);
  }
  return {
    variants,
    thumbnailWidth: isIntegerBetween(raw.thumbnailWidth, THUMBNAIL_WIDTH_MIN, THUMBNAIL_WIDTH_MAX)
      ? raw.thumbnailWidth
      : fallback.thumbnailWidth,
  };
}

export function previewVariantCode(resolution: number, watermark: boolean): string {
  return `preview_${resolution}p${watermark ? '_wm' : ''}`;
}

/**
 * Frame of a `width` x `height` source scaled so its short edge is `shortEdge`. `even` rounds
 * both sides down to even numbers, as H.264 with 4:2:0 chroma needs.
 */
export function scaleToShortEdge(
  width: number,
  height: number,
  shortEdge: number,
  even = false,
): { width: number; height: number } {
  const round = (value: number) =>
    even ? Math.max(2, Math.floor(value / 2) * 2) : Math.max(1, Math.round(value));
  if (width <= height) {
    return { width: round(shortEdge), height: round((height * shortEdge) / width) };
  }
  return { width: round((width * shortEdge) / height), height: round(shortEdge) };
}

/**
 * Previews to render for a `sourceWidth` x `sourceHeight` file. Never upscales: a variant larger
 * than the source is rendered at the source's short edge, and variants that end up identical are
 * rendered once. Without an active watermark, watermarked variants are rendered without one.
 */
export function planPreviewVariants(
  sourceWidth: number,
  sourceHeight: number,
  variants: RenderVariantSpec[],
  watermarkActive: boolean,
  even = false,
): PlannedPreview[] {
  const shortEdge = Math.min(sourceWidth, sourceHeight);
  const planned = new Map<string, PlannedPreview>();
  for (const variant of variants) {
    const resolution = Math.min(variant.resolution, shortEdge);
    const watermark = variant.watermark && watermarkActive;
    const variantCode = previewVariantCode(resolution, watermark);
    if (!planned.has(variantCode)) {
      planned.set(variantCode, {
        variantCode,
        resolution,
        watermark,
        ...scaleToShortEdge(sourceWidth, sourceHeight, resolution, even),
      });
    }
  }
  return [...planned.values()].sort(compareVariants);
}

/** SQL condition on an `asset_variants` row aliased `av` matching preview variants. */
export const PREVIEW_VARIANT_SQL = `av.variant_code ~ '^preview(_[0-9]+(p(_wm)?)?)?$'`;

/** Matches `preview_<n>p[_wm]`, the legacy `preview_<width>` and the legacy single `preview`. */
export function isPreviewVariantCode(code: string): boolean {
  return PREVIEW_VARIANT_PATTERN.test(code);
}

/** Short edge of a rendered variant, the "p" it is shown as. */
export function variantResolution(variant: {
  width: number | null;
  height: number | null;
}): number | null {
  if (!variant.width || !variant.height) {
    return variant.width ?? variant.height ?? null;
  }
  return Math.min(variant.width, variant.height);
}

/**
 * The preview to show in a frame `targetWidth` pixels wide: the smallest one at least that wide,
 * otherwise the largest. Without a target, the largest. Between two previews of the same width,
 * the watermarked one wins, so a viewer allowed to see both still gets the one meant for viewing.
 */
export function pickPreviewVariant<T extends { width: number | null; hasWatermark?: boolean }>(
  variants: T[],
  targetWidth?: number,
): T | undefined {
  const sorted = [...variants].sort(
    (a, b) => (a.width ?? 0) - (b.width ?? 0) || Number(b.hasWatermark) - Number(a.hasWatermark),
  );
  const width =
    targetWidth && targetWidth > 0
      ? (sorted.find((variant) => (variant.width ?? 0) >= targetWidth)?.width ?? undefined)
      : undefined;
  const chosenWidth = width ?? sorted.at(-1)?.width;
  return sorted.find((variant) => variant.width === chosenWidth);
}

/** A preview as offered to a viewer choosing a quality. */
export type PreviewDescription = {
  variantCode: string;
  width: number | null;
  height: number | null;
  resolution: number | null;
  hasWatermark: boolean;
  mimeType: string;
  fileSizeBytes: string;
  /** Average bitrate of a video preview, for picking a quality the connection can play. */
  bitrateBps: number | null;
};

export function describePreview(
  variant: {
    variantCode: string;
    width: number | null;
    height: number | null;
    hasWatermark: boolean;
    mimeType: string;
    fileSizeBytes: string;
  },
  durationSeconds: number | null | undefined,
): PreviewDescription {
  const bytes = Number(variant.fileSizeBytes);
  return {
    variantCode: variant.variantCode,
    width: variant.width,
    height: variant.height,
    resolution: variantResolution(variant),
    hasWatermark: variant.hasWatermark,
    mimeType: variant.mimeType,
    fileSizeBytes: variant.fileSizeBytes,
    bitrateBps:
      variant.mimeType.startsWith('video/') && durationSeconds && durationSeconds > 0 && bytes > 0
        ? Math.round((bytes * 8) / durationSeconds)
        : null,
  };
}

/** Smallest first; the un-watermarked preview before the watermarked one of the same size. */
export function comparePreviews(
  a: { width: number | null; height: number | null; hasWatermark: boolean },
  b: { width: number | null; height: number | null; hasWatermark: boolean },
): number {
  return (
    (variantResolution(a) ?? 0) - (variantResolution(b) ?? 0) ||
    (a.width ?? 0) - (b.width ?? 0) ||
    Number(a.hasWatermark) - Number(b.hasWatermark)
  );
}
