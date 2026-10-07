import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const CATEGORY_ACCESS_USER_SORT_FIELDS = ['user', 'categoryCount', 'updatedAt'] as const;
export type CategoryAccessUserSortField = (typeof CATEGORY_ACCESS_USER_SORT_FIELDS)[number];

export class CategoryAccessUsersQueryDto {
  @ApiPropertyOptional({ description: 'Tìm theo tên, email hoặc user ID' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string;

  @ApiPropertyOptional({ enum: CATEGORY_ACCESS_USER_SORT_FIELDS })
  @IsOptional()
  @IsIn(CATEGORY_ACCESS_USER_SORT_FIELDS)
  sortBy?: CategoryAccessUserSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
