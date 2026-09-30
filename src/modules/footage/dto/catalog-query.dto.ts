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
  @ApiPropertyOptional({ description: 'Include only usable segments (default true).' })
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

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated shot sizes.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  shotSizes?: string[];

  @ApiPropertyOptional({ description: 'Free-text search within captions/tags.' })
  @IsOptional()
  @IsString()
  q?: string;
}

export class FootageCatalogBodyDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Folder IDs to scope. Each must be within the user scope, else 404. 1–50.',
  })
  @IsArray()
  @IsUUID('all', { each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  folderIds!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  filters?: CatalogFiltersDto;

  @ApiPropertyOptional({
    description: 'Max items to return (default 500, max 1000).',
    default: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  @Transform(({ value }) => (value !== undefined ? Number(value) : value))
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor from the previous response.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
