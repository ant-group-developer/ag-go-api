import { createHash } from 'node:crypto';
import type { Repository } from 'typeorm';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { isAdminUserType, type UserType } from '../../common/auth/user-type';
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

/**
 * Short hash of everything that changes how the watermark looks, so a render can tell whether a
 * watermarked preview made earlier still matches the profile.
 */
export function watermarkFingerprint(profile: WatermarkProfile | null | undefined): string {
  return createHash('sha1')
    .update(JSON.stringify(normalizeWatermarkConfig(profile?.watermarkConfig)))
    .digest('hex')
    .slice(0, 12);
}

/** Thumbnails are small list images and are never watermarked by design. */
export const THUMBNAIL_VARIANT_CODE = 'thumbnail';

/**
 * Serving rule for rendered variants: while the active profile watermarks media, only
 * watermarked previews may leave the system, unless the viewer may see un-watermarked media
 * (see canViewUnwatermarked). Thumbnails and, with watermarking off, any ready variant are served.
 */
export function isVariantServable(
  variant: { hasWatermark: boolean; variantCode?: string },
  activeProfile: WatermarkProfile | null | undefined,
  viewerMaySeeUnwatermarked = false,
): boolean {
  return (
    viewerMaySeeUnwatermarked ||
    variant.variantCode === THUMBNAIL_VARIANT_CODE ||
    !isWatermarkActive(activeProfile) ||
    variant.hasWatermark
  );
}

/**
 * Un-watermarked previews are for the same people who may open the original file: admins and
 * users allowed to evaluate media or download originals.
 */
export function canViewUnwatermarked(
  permissions: readonly string[] | undefined,
  userType: UserType | undefined,
): boolean {
  return (
    isAdminUserType(userType) ||
    Boolean(
      permissions?.includes(GO_PERMISSIONS.PROJECT_EVALUATE) ||
      permissions?.includes(GO_PERMISSIONS.PROJECT_DOWNLOAD_ORIGINAL),
    )
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
