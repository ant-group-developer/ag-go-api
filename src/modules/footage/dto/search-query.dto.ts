import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

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

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated shot sizes.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  shotSizes?: string[];

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

  @ApiPropertyOptional({ description: 'Minimum duration in milliseconds.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  minDurationMs?: number;

  @ApiPropertyOptional({ description: 'Maximum duration in milliseconds.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  maxDurationMs?: number;

  @ApiPropertyOptional({
    description: 'Include only usable segments (default true).',
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
}
