import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { BaseKeywordQueryDto } from '../../../common/dto/base-keyword-query.dto';

export class ListProvincesQueryDto extends BaseKeywordQueryDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsUUID()
  countryId?: string;

  /**
   * @deprecated Use keyword for the shared list-query contract.
   */
  @ApiPropertyOptional({ deprecated: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
