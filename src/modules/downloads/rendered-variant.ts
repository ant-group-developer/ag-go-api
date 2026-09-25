import type { Repository } from 'typeorm';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { isPreviewVariantCode, pickPreviewVariant } from '../render/render-sizes';
import { findActiveRenderProfile, isVariantServable } from '../render/watermark-policy';

/**
 * The variant served for a "rendered" download: the largest watermarked preview. Never falls back
 * to the original or to the (un-watermarked) thumbnail, and follows the watermark serving rule so
 * an un-watermarked render cannot leak while watermarking is on.
 */
export async function findRenderedVariant(
  variantRepository: Repository<AssetVariantEntity>,
  profileRepository: Repository<RenderProfileEntity>,
  assetId: string,
): Promise<AssetVariantEntity | null> {
  const [variants, profile] = await Promise.all([
    variantRepository.find({ where: { assetId, status: 'ready' } }),
    findActiveRenderProfile(profileRepository),
  ]);
  return (
    pickPreviewVariant(
      variants.filter(
        (variant) =>
          isPreviewVariantCode(variant.variantCode) && isVariantServable(variant, profile),
      ),
    ) ?? null
  );
}

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** Original filename with the extension of the rendered variant, e.g. `photo.jpg` -> `photo.webp`. */
export function renderedFilename(originalFilename: string, mimeType: string): string {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType.toLowerCase()];
  if (!extension) {
    return originalFilename;
  }
  const dot = originalFilename.lastIndexOf('.');
  const base = dot > 0 ? originalFilename.slice(0, dot) : originalFilename;
  return `${base}.${extension}`;
}
