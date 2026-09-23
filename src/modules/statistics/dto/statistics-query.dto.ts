import { IsDateString, IsOptional } from 'class-validator';

export class StatisticsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
