import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class AnalysisBatchesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @ApiPropertyOptional({ enum: ['createdAt', 'name', 'status'], default: 'createdAt' })
  @IsOptional()
  @IsIn(['createdAt', 'name', 'status'])
  sortBy: 'createdAt' | 'name' | 'status' = 'createdAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({ enum: ['running', 'paused', 'cancelled', 'completed'] })
  @IsOptional()
  @IsIn(['running', 'paused', 'cancelled', 'completed'])
  status?: 'running' | 'paused' | 'cancelled' | 'completed';
}
