import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { UploadClientMetricsDto } from './complete-upload.dto';

export const UPLOAD_FAILURE_STAGES = ['part-urls', 'transfer', 'complete'] as const;
export type UploadFailureStage = (typeof UPLOAD_FAILURE_STAGES)[number];

/** One failed request while uploading (a part PUT, or asking for part URLs). */
export class UploadAttemptErrorDto {
  @ApiProperty({ description: 'When it failed, in ms since the transfer started' })
  @IsInt()
  @Min(0)
  atMs!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  partNumber?: number;

  @ApiPropertyOptional({ description: 'HTTP status; 0 when no response came back' })
  @IsOptional()
  @IsInt()
  @Min(0)
  httpStatus?: number;

  @ApiProperty()
  @IsString()
  @MaxLength(500)
  message!: string;
}

/** Why the browser gave up on an upload. Stored only to review failed uploads. */
export class UploadFailureDto {
  @ApiProperty({ enum: UPLOAD_FAILURE_STAGES })
  @IsIn(UPLOAD_FAILURE_STAGES)
  stage!: UploadFailureStage;

  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  message!: string;

  @ApiPropertyOptional({
    description: 'HTTP status of the final error; 0 when no response came back',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  httpStatus?: number;

  @ApiPropertyOptional({ description: 'Part that failed for good (multipart only)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  partNumber?: number;

  @ApiPropertyOptional({ description: 'Bytes sent before the failure' })
  @IsOptional()
  @IsInt()
  @Min(0)
  bytesSent?: number;

  @ApiPropertyOptional({ description: 'Parts fully sent before the failure (multipart only)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  partsDone?: number;

  @ApiPropertyOptional({ description: 'Time from the start of the transfer to the failure, in ms' })
  @IsOptional()
  @IsInt()
  @Min(0)
  elapsedMs?: number;

  @ApiPropertyOptional({
    type: [UploadAttemptErrorDto],
    description: 'The last failed requests, retried ones included (at most 10)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => UploadAttemptErrorDto)
  errors?: UploadAttemptErrorDto[];
}

export class AbortUploadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  uploadSessionId!: string;

  @ApiPropertyOptional({ type: UploadFailureDto, description: 'Set when the upload failed' })
  @IsOptional()
  @ValidateNested()
  @Type(() => UploadFailureDto)
  failure?: UploadFailureDto;

  @ApiPropertyOptional({
    type: UploadClientMetricsDto,
    description: 'Timings up to the failure, measured in the browser',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UploadClientMetricsDto)
  metrics?: UploadClientMetricsDto;
}
