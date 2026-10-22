import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { BaseListQueryDto } from '../../../common/dto/base-list-query.dto';
import {
  AUTO_JOB_SORT_FIELDS,
  AUTO_JOB_STATUS_FILTERS,
  type AutoJobSortField,
  type AutoJobStatusFilter,
} from '../render-job-query';

export class RenderJobPageQueryDto extends BaseListQueryDto {
  @ApiPropertyOptional({ enum: AUTO_JOB_STATUS_FILTERS })
  @IsOptional()
  @IsIn(AUTO_JOB_STATUS_FILTERS)
  status?: AutoJobStatusFilter;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({ enum: AUTO_JOB_SORT_FIELDS })
  @IsOptional()
  @IsIn(AUTO_JOB_SORT_FIELDS)
  sortBy?: AutoJobSortField;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC', 'asc', 'desc'] })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (value.toUpperCase() as 'ASC' | 'DESC') : value,
  )
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

export class ListAutoJobsQueryDto extends RenderJobPageQueryDto {
  @ApiPropertyOptional({ type: String, description: 'Optional project ID to filter auto jobs' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}
