import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';

export class GoogleDriveImportSourceDto {
  @IsString()
  fileId!: string;

  @IsOptional()
  @IsString()
  driveId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;
}

export class CreateImportDto {
  @IsUUID()
  projectId!: string;

  @IsOptional()
  @IsString()
  sourceRootId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GoogleDriveImportSourceDto)
  sources?: GoogleDriveImportSourceDto[];

  @IsOptional()
  @IsString()
  sourceDriveId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
