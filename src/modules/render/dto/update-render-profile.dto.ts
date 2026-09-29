import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  PREVIEW_RESOLUTION_MAX,
  PREVIEW_RESOLUTION_MIN,
  PREVIEW_VARIANTS_MAX_COUNT,
  THUMBNAIL_WIDTH_MAX,
  THUMBNAIL_WIDTH_MIN,
} from '../render-sizes';
import { WATERMARK_FONT_WEIGHTS, WATERMARK_LIMITS, WATERMARK_POSITIONS } from '../watermark-config';

export class RenderVariantDto {
  /** Short edge in pixels: 720 is "720p". */
  @IsInt()
  @Min(PREVIEW_RESOLUTION_MIN)
  @Max(PREVIEW_RESOLUTION_MAX)
  resolution!: number;

  @IsBoolean()
  watermark!: boolean;
}

export class RenderSizesDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PREVIEW_VARIANTS_MAX_COUNT)
  @ValidateNested({ each: true })
  @Type(() => RenderVariantDto)
  variants?: RenderVariantDto[];

  /** Legacy: preview widths, each with the profile's watermark switch. Ignored with `variants`. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @IsInt({ each: true })
  @Min(64, { each: true })
  @Max(7680, { each: true })
  previewWidths?: number[];

  @IsInt()
  @Min(THUMBNAIL_WIDTH_MIN)
  @Max(THUMBNAIL_WIDTH_MAX)
  thumbnailWidth!: number;
}

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
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a #RRGGBB hex color' })
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  fontFamily?: string;

  @IsOptional()
  @IsInt()
  @Min(WATERMARK_LIMITS.fontSize.min)
  @Max(WATERMARK_LIMITS.fontSize.max)
  fontSize?: number;

  @IsOptional()
  @IsIn(WATERMARK_FONT_WEIGHTS)
  fontWeight?: (typeof WATERMARK_FONT_WEIGHTS)[number];

  @IsOptional()
  @IsNumber()
  @Min(WATERMARK_LIMITS.logoScale.min)
  @Max(WATERMARK_LIMITS.logoScale.max)
  logoScale?: number;

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
  @Min(WATERMARK_LIMITS.scale.min)
  @Max(WATERMARK_LIMITS.scale.max)
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

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RenderSizesDto)
  renderSizes?: RenderSizesDto;
}
