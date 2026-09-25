import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';

export class SummarizeSourceDto {
  @ApiProperty()
  @IsString()
  fileId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  driveId?: string;
}

export class SummarizeSourcesDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ type: [SummarizeSourceDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SummarizeSourceDto)
  sources!: SummarizeSourceDto[];
}
