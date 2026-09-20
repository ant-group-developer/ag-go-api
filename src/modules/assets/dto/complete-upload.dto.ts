import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class CompleteUploadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  uploadSessionId!: string;

  @IsOptional()
  @ApiPropertyOptional({ pattern: '^[a-fA-F0-9]{64}$' })
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  checksumSha256?: string;
}
