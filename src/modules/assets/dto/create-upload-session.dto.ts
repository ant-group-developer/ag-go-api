import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  assetType!: 'image' | 'video';

  @IsString()
  @ApiProperty({ maxLength: 255 })
  @MaxLength(255)
  originalFilename!: string;

  @IsOptional()
  @ApiPropertyOptional({ maxLength: 20 })
  @IsString()
  @MaxLength(20)
  extension?: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  mimeType!: string;

  @Type(() => Number)
  @ApiProperty({ type: Number, minimum: 1 })
  @IsInt()
  @Min(1)
  fileSizeBytes!: number;

  @IsOptional()
  @ApiPropertyOptional({ pattern: '^[a-fA-F0-9]{64}$' })
  @Matches(/^[a-fA-F0-9]{64}$/)
  expectedChecksumSha256?: string;

  @IsOptional()
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  targetProjectId?: string;
}
