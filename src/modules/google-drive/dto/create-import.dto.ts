import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';

export const GOOGLE_DRIVE_DUPLICATE_POLICIES = [
  'create_new',
  'reuse_existing',
  'overwrite_existing',
] as const;

export type GoogleDriveDuplicatePolicy = (typeof GOOGLE_DRIVE_DUPLICATE_POLICIES)[number];

export class GoogleDriveImportSourceDto {
  @ApiProperty()
  @IsString()
  fileId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  driveId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mimeType?: string;
}

export class CreateImportDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceRootId?: string;

  @ApiPropertyOptional({ type: [GoogleDriveImportSourceDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GoogleDriveImportSourceDto)
  sources?: GoogleDriveImportSourceDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceDriveId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @ApiPropertyOptional({ enum: GOOGLE_DRIVE_DUPLICATE_POLICIES, default: 'reuse_existing' })
  @IsOptional()
  @IsIn(GOOGLE_DRIVE_DUPLICATE_POLICIES)
  duplicatePolicy?: GoogleDriveDuplicatePolicy;
}
