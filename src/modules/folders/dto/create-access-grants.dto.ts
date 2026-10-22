import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ACCESS_LEVELS, type AccessLevel } from '../../../database/entities/access-grant.entity';

export class CreateAccessGrantsDto {
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  principalId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  folderId!: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Danh mục; bỏ trống là mọi danh mục. Mỗi danh mục thành một quyền.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  categoryIds?: string[];

  @ApiProperty({ enum: ACCESS_LEVELS })
  @IsIn(ACCESS_LEVELS)
  accessLevel!: AccessLevel;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  inheritChildren?: boolean;
}
