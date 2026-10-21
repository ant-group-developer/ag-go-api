import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const ACCESS_GRANT_USER_SORT_FIELDS = [
  'user',
  'grantCount',
  'highestLevel',
  'updatedAt',
] as const;
export type AccessGrantUserSortField = (typeof ACCESS_GRANT_USER_SORT_FIELDS)[number];

export class AccessGrantUsersQueryDto {
  @ApiPropertyOptional({ description: 'Tìm theo tên, email hoặc user ID' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string;

  @ApiPropertyOptional({ enum: ACCESS_GRANT_USER_SORT_FIELDS })
  @IsOptional()
  @IsIn(ACCESS_GRANT_USER_SORT_FIELDS)
  sortBy?: AccessGrantUserSortField;

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
