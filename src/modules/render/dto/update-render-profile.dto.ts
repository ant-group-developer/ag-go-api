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
  PREVIEW_WIDTH_MAX,
  PREVIEW_WIDTH_MIN,
  PREVIEW_WIDTHS_MAX_COUNT,
  THUMBNAIL_WIDTH_MAX,
  THUMBNAIL_WIDTH_MIN,
} from '../render-sizes';
import { WATERMARK_POSITIONS } from '../watermark-config';

export class RenderSizesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PREVIEW_WIDTHS_MAX_COUNT)
  @IsInt({ each: true })
  @Min(PREVIEW_WIDTH_MIN, { each: true })
  @Max(PREVIEW_WIDTH_MAX, { each: true })
  previewWidths!: number[];

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

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RenderSizesDto)
  renderSizes?: RenderSizesDto;
}
