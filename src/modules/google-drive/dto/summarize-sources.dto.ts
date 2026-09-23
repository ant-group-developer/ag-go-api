import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

export class SummarizeSourceDto {
  @IsString()
  fileId!: string;

  @IsOptional()
  @IsString()
  driveId?: string;
}

export class SummarizeSourcesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SummarizeSourceDto)
  sources!: SummarizeSourceDto[];
}
