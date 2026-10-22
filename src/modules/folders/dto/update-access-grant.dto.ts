import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ACCESS_LEVELS, type AccessLevel } from '../../../database/entities/access-grant.entity';

export class UpdateAccessGrantDto {
  @ApiPropertyOptional({ enum: ACCESS_LEVELS })
  @IsOptional()
  @IsIn(ACCESS_LEVELS)
  accessLevel?: AccessLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inheritChildren?: boolean;
}
