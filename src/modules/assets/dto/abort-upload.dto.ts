import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AbortUploadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  uploadSessionId!: string;
}
