import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { BaseListQueryDto } from '../../../common/dto/base-list-query.dto';

export class ListProjectAuditQueryDto extends BaseListQueryDto {
  @ApiPropertyOptional({ default: 50, maximum: 100, minimum: 1, type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;
}
