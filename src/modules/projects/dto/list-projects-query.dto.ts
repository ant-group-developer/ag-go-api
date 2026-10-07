import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { BaseKeywordQueryDto } from '../../../common/dto/base-keyword-query.dto';
import {
  PROJECT_EVALUATION_STATUSES,
  type ProjectEvaluationStatus,
} from '../../media/evaluation-status';

export const PROJECT_SORT_FIELDS = ['name', 'folder', 'createdAt', 'updatedAt'] as const;
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

  @ApiPropertyOptional({
    type: [String],
    description: 'Comma-separated folder IDs; matches any folder and its descendants.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  folderIds?: string[];

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

  @ApiPropertyOptional({
    type: [String],
    description: 'Comma-separated category IDs; matches any.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  categoryIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated tag IDs; matches any.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    enum: PROJECT_EVALUATION_STATUSES,
    description: 'Comma-separated evaluation statuses; matches any.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsOptional()
  @IsArray()
  @IsIn(PROJECT_EVALUATION_STATUSES, { each: true })
  evaluationStatuses?: ProjectEvaluationStatus[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Comma-separated user IDs of project owners (authors); matches any.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ownerUserIds?: string[];

  @ApiPropertyOptional({ type: Boolean, description: 'Only projects owned by the current user.' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsOptional()
  @IsBoolean()
  mine?: boolean;
}
