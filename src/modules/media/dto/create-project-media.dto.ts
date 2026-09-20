import { ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  assetId?: string;

  @ValidateIf((value) => !value.assetId)
  @ApiPropertyOptional({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  assetType?: 'image' | 'video';

  @ValidateIf((value) => !value.assetId)
  @ApiPropertyOptional({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  originalFilename?: string;

  @ValidateIf((value) => !value.assetId)
  @ApiPropertyOptional({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  mimeType?: string;

  @ValidateIf((value) => !value.assetId)
  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fileSizeBytes?: number;

  @IsOptional()
  @ApiPropertyOptional({ maxLength: 20 })
  @IsString()
  @MaxLength(20)
  extension?: string;

  @IsOptional()
  @ApiPropertyOptional({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  originalBucket?: string;

  @IsOptional()
  @ApiPropertyOptional({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  originalStorageKey?: string;

  @IsOptional()
  @ApiPropertyOptional({ minimum: 0 })
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @ApiPropertyOptional({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  caption?: string;
}
