import type { WatermarkPosition } from './watermark-config';

/**
 * Watermark sizes (font size, margin, gaps) are authored against a 960px wide frame, which is also
 * the size of the preview canvas on the settings page. Every rendered output scales them by
 * `baseWidth / 960` so thumbnails, previews and 4K videos carry a watermark of the same proportion.
 *
 * Keep in sync with ag-go-web/src/modules/render/utils/watermark-layout.ts.
 */
export const WATERMARK_REFERENCE_WIDTH = 960;

export function getWatermarkUnitScale(baseWidth: number): number {
  return Math.max(0.05, baseWidth / WATERMARK_REFERENCE_WIDTH);
}

/** Scaled margin, capped so a corner anchor stays inside very wide or very tall frames. */
export function getWatermarkMargin(margin: number, baseWidth: number, baseHeight: number): number {
  return Math.max(
    0,
    Math.min(
      Math.round(margin * getWatermarkUnitScale(baseWidth)),
      Math.floor((Math.min(baseWidth, baseHeight) - 1) / 2),
    ),
  );
}

/**
 * Layout of the unrotated tile (logo on the left, text after it), in pixels for `fontSize`.
 * `logoScale` resizes the logo relative to its default size of 1.6x the font size.
 * Everything is snapped to whole pixels: at small sizes a logo or baseline sitting between two
 * pixel rows gets smeared over both, which is what makes low-resolution watermarks look blurry.
 */
export function getWatermarkTileGeometry(fontSize: number, hasLogo: boolean, logoScale = 1) {
  const logoSize = hasLogo ? Math.max(1, Math.round(fontSize * 1.6 * logoScale)) : 0;
  const textX = hasLogo ? Math.round(logoSize + fontSize * 0.48) : 0;
  const height = Math.ceil(Math.max(fontSize * 1.5, logoSize));
  return {
    logoSize,
    logoY: Math.floor((height - logoSize) / 2),
    textX,
    textBaselineY: Math.round(height / 2 + fontSize * 0.35),
    height,
  };
}

/** Bounding box of a `width` x `height` box rotated by `degrees` around its centre. */
export function getRotatedSize(width: number, height: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  // The epsilon keeps quarter turns exact despite floating point noise in sin/cos.
  return {
    width: Math.max(1, Math.ceil(width * cos + height * sin - 1e-6)),
    height: Math.max(1, Math.ceil(width * sin + height * cos - 1e-6)),
  };
}

/**
 * Single (non-repeated) watermark: `scale` is the width of the unrotated tile as a fraction of
 * the frame width. Returns the factor to apply to a tile rendered at the configured font size.
 */
export function getSingleWatermarkTileScale(
  referenceTileWidth: number,
  baseWidth: number,
  scale: number,
): number {
  return (baseWidth * scale) / Math.max(1, referenceTileWidth);
}

/** Shrinks (never enlarges) a box to fit inside the given bounds, keeping its aspect ratio. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number) {
  const ratio = Math.min(1, Math.max(1, maxWidth) / width, Math.max(1, maxHeight) / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * Anchors the overlay at `position`. An overlay larger than the frame keeps its anchor and hangs
 * off the opposite edges (negative offsets); use `clipToFrame` to get the visible part.
 */
export function getOverlayPosition(
  baseWidth: number,
  baseHeight: number,
  overlayWidth: number,
  overlayHeight: number,
  position: WatermarkPosition,
  margin: number,
): { top: number; left: number } {
  const right = baseWidth - overlayWidth - margin;
  const bottom = baseHeight - overlayHeight - margin;
  switch (position) {
    case 'top-left':
      return { top: margin, left: margin };
    case 'top-right':
      return { top: margin, left: right };
    case 'bottom-left':
      return { top: bottom, left: margin };
    case 'center':
      return {
        top: Math.round((baseHeight - overlayHeight) / 2),
        left: Math.round((baseWidth - overlayWidth) / 2),
      };
    case 'bottom-right':
    default:
      return { top: bottom, left: right };
  }
}

/**
 * Part of an overlay placed at (`top`, `left`) that lies inside the frame: `extract` is the region
 * to cut from the overlay and `top`/`left` where it goes. Null when nothing is visible.
 */
export function clipToFrame(
  baseWidth: number,
  baseHeight: number,
  overlayWidth: number,
  overlayHeight: number,
  top: number,
  left: number,
): {
  top: number;
  left: number;
  extract: { left: number; top: number; width: number; height: number };
} | null {
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(baseWidth, left + overlayWidth);
  const y1 = Math.min(baseHeight, top + overlayHeight);
  if (x1 <= x0 || y1 <= y0) {
    return null;
  }
  return {
    top: y0,
    left: x0,
    extract: { left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 },
  };
}

/** H.264 with yuv420p needs even frame dimensions. */
export function toEvenDimension(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Output size of the watermarked video preview. Returns null when the source size is unknown,
 * in which case ffmpeg keeps the source size (rounded to even numbers).
 */
export function getVideoRenderSize(
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
  limits: { maxWidth?: number | null; maxHeight?: number | null },
): { width: number; height: number } | null {
  if (!sourceWidth || !sourceHeight) {
    return null;
  }
  const fitted = fitWithin(
    sourceWidth,
    sourceHeight,
    limits.maxWidth ?? sourceWidth,
    limits.maxHeight ?? sourceHeight,
  );
  return { width: toEvenDimension(fitted.width), height: toEvenDimension(fitted.height) };
}
