import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { BaseListQueryDto } from '../../../common/dto/base-list-query.dto';
import {
  IMPORT_HISTORY_SORT_FIELDS,
  IMPORT_HISTORY_STATUS_FILTERS,
  IMPORT_ITEM_SORT_FIELDS,
  IMPORT_ITEM_STATUS_FILTERS,
  type ImportHistorySortField,
  type ImportHistoryStatusFilter,
  type ImportItemSortField,
  type ImportItemStatusFilter,
  type ImportSortOrder,
} from '../import-history-query';

export class ListDriveImportsQueryDto extends BaseListQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: 'Limit to one project (latest 50, not paged; other params ignored)',
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ enum: IMPORT_HISTORY_STATUS_FILTERS })
  @IsOptional()
  @IsIn(IMPORT_HISTORY_STATUS_FILTERS)
  status?: ImportHistoryStatusFilter;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Matches the project name or a source folder name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({ enum: IMPORT_HISTORY_SORT_FIELDS })
  @IsOptional()
  @IsIn(IMPORT_HISTORY_SORT_FIELDS)
  sortBy?: ImportHistorySortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc', 'ASC', 'DESC'] })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (value.toUpperCase() as ImportSortOrder) : value,
  )
  @IsIn(['ASC', 'DESC'])
  sortOrder?: ImportSortOrder;
}

export class ListDriveImportItemsQueryDto extends BaseListQueryDto {
  @ApiPropertyOptional({ enum: IMPORT_ITEM_STATUS_FILTERS })
  @IsOptional()
  @IsIn(IMPORT_ITEM_STATUS_FILTERS)
  status?: ImportItemStatusFilter;

  @ApiPropertyOptional({ maxLength: 200, description: 'Matches the file name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({ enum: IMPORT_ITEM_SORT_FIELDS })
  @IsOptional()
  @IsIn(IMPORT_ITEM_SORT_FIELDS)
  sortBy?: ImportItemSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc', 'ASC', 'DESC'] })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (value.toUpperCase() as ImportSortOrder) : value,
  )
  @IsIn(['ASC', 'DESC'])
  sortOrder?: ImportSortOrder;
}
