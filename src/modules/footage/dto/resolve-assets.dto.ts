import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const RESOLVE_PURPOSES = ['preview', 'final'] as const;
export type ResolvePurpose = (typeof RESOLVE_PURPOSES)[number];

/** Which rendition a preview render would rather read (ignored for a final render). */
export class ResolvePreferDto {
  @ApiPropertyOptional({
    description:
      'Short edge in pixels wanted (e.g. 480): that size, else the smallest above, else the largest below.',
  })
  @IsOptional()
  @IsInt()
  @Min(144)
  @Max(4320)
  short_edge?: number;

  @ApiPropertyOptional({
    description: 'An un-watermarked rendition first, when the user may see one.',
  })
  @IsOptional()
  @IsBoolean()
  clean?: boolean;
}

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

  @ApiPropertyOptional({ type: ResolvePreferDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ResolvePreferDto)
  prefer?: ResolvePreferDto;
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
  /** Size of the file when known (sent with a `prefer` answer). */
  width?: number | null;
  height?: number | null;
};

export type ResolveAssetsResponse = {
  items: ResolvedAssetItem[];
  /** In scope, but nothing servable for this user (e.g. no ready preview variant). */
  missing: string[];
};
