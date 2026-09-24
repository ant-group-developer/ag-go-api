import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WATERMARK_POSITIONS } from '../watermark-config';

export class WatermarkConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  text?: string;

  @IsOptional()
  @IsUUID()
  logoAssetId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(9)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  fontFamily?: string;

  @IsOptional()
  @IsInt()
  @Min(8)
  @Max(240)
  fontSize?: number;

  @IsOptional()
  @IsBoolean()
  repeat?: boolean;

  @IsOptional()
  @IsInt()
  @Min(40)
  @Max(2000)
  gapX?: number;

  @IsOptional()
  @IsInt()
  @Min(40)
  @Max(2000)
  gapY?: number;

  @IsOptional()
  @IsNumber()
  @Min(-360)
  @Max(360)
  rotate?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxWidth?: number | null;

  @IsOptional()
  @IsIn(WATERMARK_POSITIONS)
  position?: (typeof WATERMARK_POSITIONS)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  opacity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(1)
  scale?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  margin?: number;
}

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
  @ValidateNested()
  @Type(() => WatermarkConfigDto)
  watermarkConfig?: WatermarkConfigDto;
}
