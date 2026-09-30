import { ApiProperty } from '@nestjs/swagger';
import { IsArray } from 'class-validator';

export class SignOpDto {
  op!: string;
  [key: string]: unknown;
}

export class SignRequestDto {
  @ApiProperty({ description: 'List of sign operations', isArray: true })
  @IsArray()
  ops!: unknown[];
}
