import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BaseListQueryDto } from '../../../common/dto/base-list-query.dto';
import {
  CTV_LEVELS,
  RATE_CARD_PRICING_TYPES,
  RATE_CARD_STATUSES,
  type CtvLevel,
  type RateCardLevel,
  type RateCardPricingType,
  type RateCardStatus,
} from '../../pricing-engine/rate-card';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property phải có dạng YYYY-MM-DD';
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_MONEY = 1e13;

export class ListRateCardsQueryDto extends BaseListQueryDto {
  @ApiPropertyOptional({ example: 'CTV-2026' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional({ enum: RATE_CARD_STATUSES })
  @IsOptional()
  @IsIn(RATE_CARD_STATUSES)
  status?: RateCardStatus;
}

export class EffectiveRateCardQueryDto {
  @ApiProperty({ example: 'CTV-2026' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @ApiPropertyOptional({ example: '2026-07-20', description: 'Mặc định hôm nay' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  date?: string;
}

export class DurationRuleDto {
  @ApiProperty({ example: 10, description: 'File ngắn hơn không là source' })
  @IsInt()
  @Min(0)
  @Max(3600)
  minSeconds!: number;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(0)
  @Max(3600)
  preferredSeconds!: number;

  @ApiProperty({ example: 0.8 })
  @IsNumber()
  @Min(0)
  @Max(1)
  preferredRatio!: number;
}

export class RateCardItemDto {
  @ApiProperty({ format: 'uuid', description: 'Sản phẩm = danh mục' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ enum: [...CTV_LEVELS, 'ALL'] })
  @IsIn([...CTV_LEVELS, 'ALL'])
  level!: RateCardLevel;

  @ApiProperty({ enum: RATE_CARD_PRICING_TYPES })
  @IsIn(RATE_CARD_PRICING_TYPES)
  pricingType!: RateCardPricingType;

  @ApiPropertyOptional({ nullable: true, example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  tier?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 70 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sourceMin?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sourceMax?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 7 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sceneMin?: number | null;

  @ApiProperty({ example: 800000, description: 'Đồng' })
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  price!: number;

  @ApiPropertyOptional({ nullable: true, example: 300 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minSourceSeconds?: number | null;
}

export class LevelRuleDto {
  @ApiProperty({ enum: CTV_LEVELS })
  @IsIn(CTV_LEVELS)
  level!: CtvLevel;

  @ApiProperty({ example: 80000 })
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  extraScenePrice!: number;

  @ApiProperty({ example: 8 })
  @IsInt()
  @Min(0)
  @Max(10000)
  extraSceneMinSources!: number;
}

export class UpdateRateCardDto {
  @ApiPropertyOptional({ example: '2026-07-15' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  effectiveFrom?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({ type: DurationRuleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DurationRuleDto)
  durationRule?: DurationRuleDto;

  @ApiPropertyOptional({ type: [RateCardItemDto], description: 'Thay toàn bộ ô giá' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => RateCardItemDto)
  items?: RateCardItemDto[];

  @ApiPropertyOptional({ type: [LevelRuleDto], description: 'Thay toàn bộ quy tắc cấp' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LevelRuleDto)
  levelRules?: LevelRuleDto[];
}

export class CreateRateCardDto extends UpdateRateCardDto {
  @ApiProperty({ example: 'CTV-2026', description: 'Phiên bản tự tăng theo mã' })
  @IsString()
  @Matches(CODE, { message: '$property chỉ gồm chữ, số, dấu chấm, gạch' })
  @MaxLength(50)
  code!: string;

  @ApiProperty({ example: '2026-07-15' })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  declare effectiveFrom: string;
}

export class CloneRateCardDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Mặc định bằng bản gốc' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class PublishRateCardDto {
  @ApiPropertyOptional({
    example: '2026-07-15',
    description: 'Đổi ngày hiệu lực khi phát hành; phiên bản trước kết thúc vào ngày hôm trước',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  effectiveFrom?: string;
}

export class ImportRateCardDto {
  @ApiProperty({ example: 'CTV-2026' })
  @IsString()
  @Matches(CODE, { message: '$property chỉ gồm chữ, số, dấu chấm, gạch' })
  @MaxLength(50)
  code!: string;

  @ApiProperty({ example: '2026-07-15' })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  effectiveFrom!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
