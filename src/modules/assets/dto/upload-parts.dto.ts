import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsUUID, Max, Min } from 'class-validator';

export class UploadPartsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  uploadSessionId!: string;

  @ApiProperty({
    type: [Number],
    minItems: 1,
    maxItems: 100,
    description: 'Part numbers (1-based) to get presigned upload URLs for',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10_000, { each: true })
  partNumbers!: number[];
}
