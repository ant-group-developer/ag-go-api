import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { BaseListQueryDto } from './base-list-query.dto';

export class BaseKeywordQueryDto extends BaseListQueryDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string;

  get normalizedKeyword(): string | undefined {
    const value = this.keyword?.trim();
    return value || undefined;
  }
}
