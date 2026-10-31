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

  @ApiProperty({ format: 'uuid', description: 'Project that owns this uploaded asset' })
  @IsUUID()
  targetProjectId!: string;

  @IsOptional()
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Groups files uploaded together so the project audit log shows one entry per batch. ' +
      'Without it the file is logged on its own.',
  })
  @IsUUID()
  uploadBatchId?: string;

  @IsOptional()
  @ApiPropertyOptional({
    description:
      'The file’s last-modified time (File.lastModified, ms). With the name and size it tells ' +
      'the same file chosen again, so an unfinished large upload of it carries on instead of ' +
      'starting over.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fileLastModified?: number;
}
