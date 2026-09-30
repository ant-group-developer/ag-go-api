import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID } from 'class-validator';

export const RESOLVE_PURPOSES = ['preview', 'final'] as const;
export type ResolvePurpose = (typeof RESOLVE_PURPOSES)[number];

export class ResolveAssetsDto {
  @ApiProperty({ type: [String], description: 'Asset (video) IDs to resolve (1–500).' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  assetIds!: string[];

  @ApiProperty({ enum: RESOLVE_PURPOSES })
  @IsIn(RESOLVE_PURPOSES)
  purpose!: ResolvePurpose;
}

/** A signed URL of the WHOLE video file a render worker reads. */
export type ResolvedAssetItem = {
  assetId: string;
  url: string;
  sourceKind: 'original' | 'proxy' | 'preview';
  watermarked: boolean;
  contentType: string;
  sizeBytes: number | null;
  durationMs: number | null;
  /** Stable per file: render workers cache downloads by it. */
  cacheKey: string;
  expiresAt: string;
};

export type ResolveAssetsResponse = {
  items: ResolvedAssetItem[];
  /** In scope, but nothing servable for this user (e.g. no ready preview variant). */
  missing: string[];
};
