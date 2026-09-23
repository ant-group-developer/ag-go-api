import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateRenderProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(['webp', 'jpeg', 'jpg', 'png', 'mp4', 'webm'])
  outputFormat?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxWidth?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxHeight?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  imageQuality?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  videoBitrateBps?: string | null;

  @IsOptional()
  @IsBoolean()
  watermarkEnabled?: boolean;

  @IsOptional()
  @IsObject()
  watermarkConfig?: Record<string, unknown>;
}
