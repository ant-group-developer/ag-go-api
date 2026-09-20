import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class ReorderProjectMediaDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  mediaIds!: string[];
}
