import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  STATISTICS_BREAKDOWN_DIMENSIONS,
  STATISTICS_BREAKDOWN_RANGES,
  type StatisticsBreakdownDimension,
  type StatisticsBreakdownRange,
} from '../statistics.types';
import { StatisticsPeriodQueryDto } from './statistics-period-query.dto';

export class StatisticsBreakdownQueryDto extends StatisticsPeriodQueryDto {
  @ApiProperty({ enum: STATISTICS_BREAKDOWN_DIMENSIONS })
  @IsIn(STATISTICS_BREAKDOWN_DIMENSIONS)
  dimension!: StatisticsBreakdownDimension;

  @ApiPropertyOptional({
    enum: STATISTICS_BREAKDOWN_RANGES,
    default: 'all',
    description: '`all`: current state; `period`: projects created and media added in the period',
  })
  @IsOptional()
  @IsIn(STATISTICS_BREAKDOWN_RANGES)
  range?: StatisticsBreakdownRange;
}
