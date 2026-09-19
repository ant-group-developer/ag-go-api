import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateUploadSessionDto {
  @IsIn(['image', 'video'])
  assetType!: 'image' | 'video';

  @IsString()
  @MaxLength(255)
  originalFilename!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  extension?: string;

  @IsString()
  @MaxLength(100)
  mimeType!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  fileSizeBytes!: number;

  @IsOptional()
  @Matches(/^[a-fA-F0-9]{64}$/)
  expectedChecksumSha256?: string;

  @IsOptional()
  @IsUUID()
  targetProjectId?: string;
}
