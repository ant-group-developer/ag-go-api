import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const BULK_APPROVE_MAX_MEDIA = 1000;

export class BulkApproveProjectMediaDto {
  @ApiProperty({ type: [String], format: 'uuid', maxItems: BULK_APPROVE_MAX_MEDIA })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(BULK_APPROVE_MAX_MEDIA)
  @IsUUID('all', { each: true })
  mediaIds!: string[];

  @ApiPropertyOptional({ type: String, maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}
