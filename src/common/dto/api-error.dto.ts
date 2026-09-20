import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorDto {
  @ApiProperty({ example: 'VALIDATION_ERROR' })
  code: string;

  @ApiProperty({ example: 'Request validation failed' })
  message: string;

  @ApiPropertyOptional({ nullable: true })
  details?: unknown;

  @ApiPropertyOptional({ nullable: true, type: Object })
  fieldErrors?: Record<string, string[]>;

  constructor(
    code: string,
    message: string,
    options?: {
      details?: unknown;
      fieldErrors?: Record<string, string[]>;
    },
  ) {
    this.code = code;
    this.message = message;
    this.details = options?.details;
    this.fieldErrors = options?.fieldErrors;
  }
}
