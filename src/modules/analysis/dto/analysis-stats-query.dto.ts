import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsUUID } from 'class-validator';

export class AnalysisStatsQueryDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Comma-separated folder IDs; omit for every folder the caller can analyse',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : value,
  )
  folderIds?: string[];
}
