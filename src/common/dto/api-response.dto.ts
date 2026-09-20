import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiErrorDto } from './api-error.dto';

export class ApiResponseDto<T> {
  @ApiProperty({ nullable: true })
  data: T | null;

  @ApiProperty()
  requestId: string;

  @ApiProperty({ example: '2026-09-20T10:30:00.000Z' })
  timestamp: string;

  @ApiProperty()
  success: boolean;

  @ApiPropertyOptional({ nullable: true, type: ApiErrorDto })
  error: ApiErrorDto | null;

  constructor(
    data: T | null,
    requestId: string,
    success: boolean,
    error: ApiErrorDto | null = null,
    timestamp = new Date().toISOString(),
  ) {
    this.data = data;
    this.requestId = requestId;
    this.timestamp = timestamp;
    this.success = success;
    this.error = error;
  }
}
