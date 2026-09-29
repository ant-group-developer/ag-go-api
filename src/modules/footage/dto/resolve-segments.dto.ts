import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID } from 'class-validator';

export const RESOLVE_PURPOSES = ['preview', 'final'] as const;
export type ResolvePurpose = (typeof RESOLVE_PURPOSES)[number];

export class ResolveSegmentsDto {
  @ApiProperty({ type: [String], description: 'Segment IDs to resolve (1–500).' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  segmentIds!: string[];

  @ApiProperty({ enum: RESOLVE_PURPOSES })
  @IsIn(RESOLVE_PURPOSES)
  purpose!: ResolvePurpose;
}

export type ResolvedSegmentItem = {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  url: string;
  sourceKind: 'original' | 'proxy' | 'preview';
  watermarked: boolean;
  contentType: string;
  sizeBytes: number | null;
  cacheKey: string | null;
  expiresAt: string;
};

export type ResolveSegmentsResponse = {
  items: ResolvedSegmentItem[];
};
