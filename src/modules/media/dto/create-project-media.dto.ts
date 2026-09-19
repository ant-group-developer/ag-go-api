import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateProjectMediaDto {
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ValidateIf((value) => !value.assetId)
  @IsIn(['image', 'video'])
  assetType?: 'image' | 'video';

  @ValidateIf((value) => !value.assetId)
  @IsString()
  @MaxLength(255)
  originalFilename?: string;

  @ValidateIf((value) => !value.assetId)
  @IsString()
  @MaxLength(100)
  mimeType?: string;

  @ValidateIf((value) => !value.assetId)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fileSizeBytes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  extension?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  originalBucket?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  originalStorageKey?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;
}
