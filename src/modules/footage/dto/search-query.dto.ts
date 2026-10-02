import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Resolution classes by the short edge of the frame (see `RESOLUTION_CLASS_SQL`). */
export const FOOTAGE_RESOLUTIONS = ['4k', '2k', '1080p', '720p', 'sd'] as const;
export type FootageResolution = (typeof FOOTAGE_RESOLUTIONS)[number];

export const FOOTAGE_SORT_FIELDS = [
  'relevance',
  'analyzedAt',
  'quality',
  'duration',
  'resolution',
  'name',
  'folder',
  'project',
] as const;
export type FootageSortField = (typeof FOOTAGE_SORT_FIELDS)[number];

/** Which videos to list by the AI verdict "usable"; `all` lists both. */
export const FOOTAGE_USABILITIES = ['usable', 'unusable', 'all'] as const;
export type FootageUsability = (typeof FOOTAGE_USABILITIES)[number];

export const FOOTAGE_SORT_ORDERS = ['asc', 'desc'] as const;
export type FootageSortOrder = (typeof FOOTAGE_SORT_ORDERS)[number];

export class FootageSearchQueryDto {
  @ApiPropertyOptional({ description: 'Free-text search query.' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Comma-separated folder IDs (subfolders the user can reach are included).',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  folderIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated category IDs.' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  categoryIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated project IDs.' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  projectIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Comma-separated user IDs of project owners (authors).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  ownerUserIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    enum: FOOTAGE_RESOLUTIONS,
    description: 'Comma-separated resolution classes (by the short edge of the frame).',
  })
  @IsOptional()
  @IsArray()
  @IsIn(FOOTAGE_RESOLUTIONS, { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  resolutions?: FootageResolution[];

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated tag values.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  tags?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated province IDs.' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  provinceIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated genres.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  genres?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated times of day.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  timesOfDay?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated orientations.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  orientations?: string[];

  @ApiPropertyOptional({ description: 'Minimum video duration in milliseconds.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  minDurationMs?: number;

  @ApiPropertyOptional({ description: 'Maximum video duration in milliseconds.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  maxDurationMs?: number;

  @ApiPropertyOptional({
    description: 'Include only usable videos (default true).',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return true;
  })
  usableOnly?: boolean;

  @ApiPropertyOptional({
    enum: FOOTAGE_USABILITIES,
    description: 'Usable videos, unusable ones or all; wins over `usableOnly` (default usable).',
  })
  @IsOptional()
  @IsIn(FOOTAGE_USABILITIES)
  usability?: FootageUsability;

  @ApiPropertyOptional({ description: 'Max items per page (default 40, max 100).', default: 40 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based); wins over `cursor`.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  page?: number;

  @ApiPropertyOptional({
    enum: FOOTAGE_SORT_FIELDS,
    default: 'relevance',
    description:
      'relevance = text match (with `q`), quality and approval; folder / project = the first ' +
      'visible project of the video (by folder path, by name).',
  })
  @IsOptional()
  @IsIn(FOOTAGE_SORT_FIELDS)
  sortBy?: FootageSortField;

  @ApiPropertyOptional({ enum: FOOTAGE_SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(FOOTAGE_SORT_ORDERS)
  sortOrder?: FootageSortOrder;
}

export class FootagePreviewUrlQueryDto {
  @ApiProperty({ description: 'Preview variant code (from `/footage/assets/:id/media`).' })
  @IsString()
  variantCode!: string;
}
