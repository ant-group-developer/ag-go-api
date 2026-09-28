import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const BULK_APPROVE_MAX_PROJECTS = 100;

export class BulkApproveProjectsDto {
  @ApiProperty({ type: [String], format: 'uuid', maxItems: BULK_APPROVE_MAX_PROJECTS })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(BULK_APPROVE_MAX_PROJECTS)
  @IsUUID('all', { each: true })
  projectIds!: string[];

  @ApiPropertyOptional({
    default: false,
    description: 'Also approve files currently rejected; otherwise only pending files change.',
  })
  @IsOptional()
  @IsBoolean()
  overrideRejected?: boolean;

  @ApiPropertyOptional({ type: String, maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}
