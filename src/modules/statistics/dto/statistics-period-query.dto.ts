import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsTimeZone } from 'class-validator';

/** Reporting window of the statistics page. `to` is exclusive. */
export class StatisticsPeriodQueryDto {
  @ApiProperty({
    description: 'Start of the period (inclusive)',
    example: '2026-09-01T00:00:00+07:00',
  })
  @IsDateString()
  from!: string;

  @ApiProperty({
    description: 'End of the period (exclusive)',
    example: '2026-10-01T00:00:00+07:00',
  })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({
    description: 'IANA time zone used to group the trend by day or week',
    default: 'Asia/Ho_Chi_Minh',
  })
  @IsOptional()
  @IsTimeZone()
  tz?: string;
}
