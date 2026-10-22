import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { BaseKeywordQueryDto } from '../../../common/dto/base-keyword-query.dto';

export const PROVINCE_SORT_FIELDS = ['name', 'code', 'country'] as const;
export type ProvinceSortField = (typeof PROVINCE_SORT_FIELDS)[number];

export class ListProvincesQueryDto extends BaseKeywordQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  countryId?: string;

  /** Without it: by country, then the provinces' own order. */
  @ApiPropertyOptional({ enum: PROVINCE_SORT_FIELDS })
  @IsOptional()
  @IsIn(PROVINCE_SORT_FIELDS)
  sortBy?: ProvinceSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
