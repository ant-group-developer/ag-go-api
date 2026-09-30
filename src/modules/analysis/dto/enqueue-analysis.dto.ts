import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';

export class EnqueueAnalysisDto {
  @ApiPropertyOptional({ default: 0, description: 'Priority for this analysis job' })
  @IsOptional()
  @IsNumber()
  priority?: number;
}
