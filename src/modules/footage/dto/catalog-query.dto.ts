import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CatalogFiltersDto {
  @ApiPropertyOptional({ description: 'Include only usable videos (default true).' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  usableOnly?: boolean;

  @ApiPropertyOptional({ description: 'Minimum quality score (0–5).' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  minQuality?: number;

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated orientations.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  orientations?: string[];

  @ApiPropertyOptional({ description: 'Free-text search within titles, summaries, tags.' })
  @IsOptional()
  @IsString()
  q?: string;
}

/** Filters may come flat on the body (current) or under `filters` (older clients); flat wins. */
export class FootageCatalogBodyDto extends CatalogFiltersDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Folder IDs to scope (subfolders the user can reach are included). Each must be within the user scope, else 404. 1–50.',
  })
  @IsArray()
  @IsUUID('all', { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  folderIds!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  filters?: CatalogFiltersDto;

  @ApiPropertyOptional({
    description: 'Max videos to return (default 200, max 500).',
    default: 200,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor from the previous response.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
