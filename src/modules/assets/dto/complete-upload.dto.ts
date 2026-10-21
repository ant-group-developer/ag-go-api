import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** How the browser sent the file, measured on its side. Stored only to review upload speed. */
export class UploadClientMetricsDto {
  @ApiProperty({ enum: ['single', 'multipart'] })
  @IsIn(['single', 'multipart'])
  mode!: 'single' | 'multipart';

  @ApiProperty({ description: 'Time spent sending the file content to storage, in ms' })
  @IsInt()
  @Min(0)
  transferMs!: number;

  @ApiPropertyOptional({ description: 'Time spent waiting for part URLs from the API, in ms' })
  @IsOptional()
  @IsInt()
  @Min(0)
  partUrlWaitMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  partSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  partCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  parallelParts?: number;

  @ApiPropertyOptional({ description: 'Failed part attempts that were retried' })
  @IsOptional()
  @IsInt()
  @Min(0)
  retries?: number;

  @ApiPropertyOptional({ description: 'Files uploading at the same time in the browser' })
  @IsOptional()
  @IsInt()
  @Min(0)
  concurrentUploads?: number;

  @ApiPropertyOptional({ description: 'navigator.connection.effectiveType (Chromium only)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  networkType?: string;

  @ApiPropertyOptional({ description: 'navigator.connection.downlink in Mbps (Chromium only)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  downlinkMbps?: number;

  @ApiPropertyOptional({ description: 'navigator.connection.rtt in ms (Chromium only)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  rttMs?: number;
}

export class CompleteUploadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  uploadSessionId!: string;

  @IsOptional()
  @ApiPropertyOptional({ pattern: '^[a-fA-F0-9]{64}$' })
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  checksumSha256?: string;

  @ApiPropertyOptional({ type: UploadClientMetricsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UploadClientMetricsDto)
  metrics?: UploadClientMetricsDto;
}
