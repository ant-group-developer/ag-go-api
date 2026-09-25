import type { Repository } from 'typeorm';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { normalizeWatermarkConfig } from './watermark-config';

type WatermarkProfile = Pick<RenderProfileEntity, 'watermarkEnabled' | 'watermarkConfig'>;

/**
 * A profile only produces a watermark when it is enabled and has something to draw.
 */
export function isWatermarkActive(profile: WatermarkProfile | null | undefined): boolean {
  if (!profile?.watermarkEnabled) {
    return false;
  }
  const config = normalizeWatermarkConfig(profile.watermarkConfig);
  return Boolean(config.text.trim() || config.logoAssetId);
}

/** Thumbnails are small list images and are never watermarked by design. */
export const THUMBNAIL_VARIANT_CODE = 'thumbnail';

/**
 * Serving rule for rendered variants: while the active profile watermarks media, only
 * watermarked previews may leave the system. Thumbnails and, with watermarking off, any ready
 * variant are served.
 */
export function isVariantServable(
  variant: { hasWatermark: boolean; variantCode?: string },
  activeProfile: WatermarkProfile | null | undefined,
): boolean {
  return (
    variant.variantCode === THUMBNAIL_VARIANT_CODE ||
    !isWatermarkActive(activeProfile) ||
    variant.hasWatermark
  );
}

export function findActiveRenderProfile(
  repository: Repository<RenderProfileEntity>,
): Promise<RenderProfileEntity | null> {
  return repository.findOne({
    where: { code: 'default', isActive: true },
    order: { profileVersion: 'DESC' },
  });
}

/** `assets.source_metadata.purpose` of the uploaded watermark logo. */
export const WATERMARK_LOGO_PURPOSE = 'watermark_logo';
