import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class BackfillAnalysisDto {
  @ApiPropertyOptional({ description: 'Batch name shown in the batches list' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Folder ids to backfill (includes subfolders)',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  folderIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Project ids to backfill' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  projectIds?: string[];

  @ApiProperty({ enum: ['missing', 'outdated', 'all'] })
  @IsIn(['missing', 'outdated', 'all'])
  mode!: 'missing' | 'outdated' | 'all';

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  priority?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
