import type { RenderProfileEntity } from '../../database/entities/render-profile.entity';

/**
 * Output sizes of a render profile. Only widths are configured: heights always follow the aspect
 * ratio of the file. Previews carry the watermark, the thumbnail never does.
 */
export type RenderSizes = {
  previewWidths: number[];
  thumbnailWidth: number;
};

export const PREVIEW_WIDTH_MIN = 64;
export const PREVIEW_WIDTH_MAX = 7680;
export const PREVIEW_WIDTHS_MAX_COUNT = 6;
export const THUMBNAIL_WIDTH_MIN = 64;
export const THUMBNAIL_WIDTH_MAX = 1024;

const LEGACY_PREVIEW_VARIANT_CODE = 'preview';
const PREVIEW_VARIANT_PATTERN = /^preview_(\d+)$/;

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function normalizePreviewWidths(value: unknown): number[] {
  const widths = Array.isArray(value)
    ? value.filter((width): width is number =>
        isIntegerBetween(width, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX),
      )
    : [];
  return [...new Set(widths)].sort((a, b) => a - b).slice(0, PREVIEW_WIDTHS_MAX_COUNT);
}

/**
 * Sizes of a profile, falling back to the legacy `max_width` column and then to the
 * MEDIA_PREVIEW_MAX_WIDTH / MEDIA_THUMBNAIL_MAX_WIDTH environment values.
 */
export function normalizeRenderSizes(
  profile: Pick<RenderProfileEntity, 'renderSizes' | 'maxWidth'> | null | undefined,
  fallback: { previewWidth: number; thumbnailWidth: number },
): RenderSizes {
  const raw = profile?.renderSizes ?? {};
  const previewWidths = normalizePreviewWidths(raw.previewWidths);
  return {
    previewWidths:
      previewWidths.length > 0 ? previewWidths : [profile?.maxWidth ?? fallback.previewWidth],
    thumbnailWidth: isIntegerBetween(raw.thumbnailWidth, THUMBNAIL_WIDTH_MIN, THUMBNAIL_WIDTH_MAX)
      ? raw.thumbnailWidth
      : fallback.thumbnailWidth,
  };
}

/** Widths to render for a source: never upscale, but always render at least one size. */
export function selectPreviewWidths(sourceWidth: number, widths: number[]): number[] {
  const fitting = widths.filter((width) => width <= sourceWidth);
  return fitting.length > 0 ? fitting : [sourceWidth];
}

export function previewVariantCode(width: number): string {
  return `preview_${width}`;
}

/** SQL condition on an `asset_variants` row aliased `av` matching preview variants. */
export const PREVIEW_VARIANT_SQL = `(av.variant_code = 'preview' OR av.variant_code ~ '^preview_[0-9]+$')`;

/** Matches `preview_<width>` and the legacy single `preview` variant. */
export function isPreviewVariantCode(code: string): boolean {
  return code === LEGACY_PREVIEW_VARIANT_CODE || PREVIEW_VARIANT_PATTERN.test(code);
}

/**
 * The preview to show in a frame `targetWidth` pixels wide: the smallest one at least that wide,
 * otherwise the largest. Without a target, the largest.
 */
export function pickPreviewVariant<T extends { width: number | null }>(
  variants: T[],
  targetWidth?: number,
): T | undefined {
  const sorted = [...variants].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  if (targetWidth && targetWidth > 0) {
    const fitting = sorted.find((variant) => (variant.width ?? 0) >= targetWidth);
    if (fitting) {
      return fitting;
    }
  }
  return sorted.at(-1);
}
