import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { BaseKeywordQueryDto } from '../../../common/dto/base-keyword-query.dto';

export const PROJECT_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;
export type ProjectSortField = (typeof PROJECT_SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export class ListProjectsQueryDto extends BaseKeywordQueryDto {
  @ApiPropertyOptional({ enum: PROJECT_SORT_FIELDS, default: 'updatedAt' })
  @IsOptional()
  @IsIn(PROJECT_SORT_FIELDS)
  sortBy?: ProjectSortField;

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  sortOrder?: SortOrder;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filters by a folder and its descendants.' })
  @IsOptional()
  @IsUUID()
  folderId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  countryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  provinceId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated tag IDs; matches any.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  tagIds?: string[];
}
