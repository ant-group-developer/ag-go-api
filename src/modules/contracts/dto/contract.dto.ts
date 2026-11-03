import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BaseKeywordQueryDto } from '../../../common/dto/base-keyword-query.dto';
import {
  ACCEPTANCE_CYCLES,
  ADVANCE_OFFSET_RULES,
  CONTRACT_STATUSES,
  CONTRACT_TYPES,
  PRICING_MODELS,
  type AcceptanceCycle,
  type AdvanceOffsetRule,
  type ContractStatus,
  type ContractType,
  type PricingModel,
} from '../../../database/entities/contract.entity';
import { TECH_SPEC_PRESETS } from '../contract-terms';

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property phải có dạng YYYY-MM-DD';
const MAX_MONEY = 1e15;

export class ListContractsQueryDto extends BaseKeywordQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ enum: CONTRACT_STATUSES })
  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: ContractStatus;

  @ApiPropertyOptional({ enum: PRICING_MODELS })
  @IsOptional()
  @IsIn(PRICING_MODELS)
  pricingModel?: PricingModel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  managerUserId?: string;
}

/** Terms shared by create and draft update. Money is whole đồng. */
class ContractTermsDto {
  @ApiPropertyOptional({ enum: CONTRACT_TYPES, default: 'content_production' })
  @IsOptional()
  @IsIn(CONTRACT_TYPES)
  contractType?: ContractType;

  @ApiPropertyOptional({
    description: 'Bỏ trống = tự sinh DDMMYY/HĐSXND/AG-<mã> (BR-05); sửa được khi còn nháp',
    example: '010826/HĐSXND/AG-NHH',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  contractNumber?: string;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Ngày ký (bắt buộc khi kích hoạt)' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  signedDate?: string | null;

  @ApiPropertyOptional({ example: '2026-08-01', nullable: true })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  endDate?: string | null;

  @ApiPropertyOptional({ description: 'Trần giá trị HĐ (đồng); null = không trần', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  capAmount?: number | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  advanceAmount?: number;

  @ApiPropertyOptional({ description: 'Hạn tạm ứng (ngày làm việc), bắt buộc khi có tạm ứng' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  advanceDueBusinessDays?: number | null;

  @ApiPropertyOptional({ enum: ADVANCE_OFFSET_RULES, default: 'full_first' })
  @IsOptional()
  @IsIn(ADVANCE_OFFSET_RULES)
  advanceOffsetRule?: AdvanceOffsetRule;

  @ApiPropertyOptional({
    description: '{ "type": "monthly_before_day", "day": 15 } hoặc { "type": "flexible" }',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  deliveryRule?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Tech spec (đặc tả 8.1); bỏ trống khi tạo = preset techSpecPreset',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  techSpec?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: Object.keys(TECH_SPEC_PRESETS), default: 'footage_4k60' })
  @IsOptional()
  @IsIn(Object.keys(TECH_SPEC_PRESETS))
  techSpecPreset?: string;

  @ApiPropertyOptional({ default: 8 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  penaltyPercent?: number;

  @ApiPropertyOptional({ nullable: true, example: 70 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  originalityMinPercent?: number | null;

  @ApiPropertyOptional({ nullable: true, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  similarityMaxPercent?: number | null;

  @ApiPropertyOptional({ nullable: true, default: 24 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  nonCompeteMonths?: number | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  templateVersionId?: string | null;

  @ApiPropertyOptional({ description: 'Người phụ trách; mặc định của đối tác' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  managerUserId?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  note?: string | null;
}

export class CreateContractDto extends ContractTermsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  partnerId!: string;

  @ApiProperty({ example: '2026-08-01' })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  startDate!: string;

  @ApiProperty({ enum: PRICING_MODELS })
  @IsIn(PRICING_MODELS)
  pricingModel!: PricingModel;

  @ApiProperty({
    description: 'Cấu hình giá theo mô hình (đặc tả 7.2): per_topic / per_unit / package_tier',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  pricingConfig!: Record<string, unknown>;

  @ApiProperty({ enum: ACCEPTANCE_CYCLES })
  @IsIn(ACCEPTANCE_CYCLES)
  acceptanceCycle!: AcceptanceCycle;

  @ApiProperty({ example: 10, description: 'Hạn thanh toán (ngày làm việc)' })
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermBusinessDays!: number;
}

/**
 * Terms are only editable while `draft`; manager and note in any status. Changing the pricing
 * model requires its pricing config.
 */
export class UpdateContractDto extends PartialType(ContractTermsDto) {
  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  startDate?: string;

  @ApiPropertyOptional({ enum: PRICING_MODELS })
  @IsOptional()
  @IsIn(PRICING_MODELS)
  pricingModel?: PricingModel;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  pricingConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: ACCEPTANCE_CYCLES })
  @IsOptional()
  @IsIn(ACCEPTANCE_CYCLES)
  acceptanceCycle?: AcceptanceCycle;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermBusinessDays?: number;

  @ApiPropertyOptional({
    description: 'Sinh lại số HĐ theo ngày ký / ngày bắt đầu mới (khi không gửi contractNumber)',
  })
  @IsOptional()
  @IsBoolean()
  regenerateNumber?: boolean;
}

export class NextContractNumberQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  partnerId!: string;

  @ApiProperty({ example: '2026-08-01', description: 'Ngày ký dự kiến' })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  date!: string;
}

export class ActivateContractDto {
  @ApiPropertyOptional({ example: '2026-08-01', description: 'Ngày ký; bắt buộc nếu HĐ chưa có' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  signedDate?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Bản ký đã upload' })
  @IsOptional()
  @IsUUID()
  signedFileId?: string;

  @ApiPropertyOptional({
    description: 'Quản trị kích hoạt khi chưa có bản ký: bắt buộc nêu lý do (FR-C-06)',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  skipSignedFileReason?: string;
}

export class ContractReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class TerminateContractDto {
  @ApiProperty({ description: 'Lý do chấm dứt / thanh lý (FR-C-10)' })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;
}

export class ContractTermsQueryDto {
  @ApiPropertyOptional({ example: '2026-09-30', description: 'Mặc định hôm nay' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  date?: string;
}

/** Amended terms, new values (spec 7.3). */
export class AmendmentChangesDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  pricingConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  capAmount?: number | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  techSpec?: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  endDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermBusinessDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  penaltyPercent?: number;
}

export class CreateAmendmentDto {
  @ApiProperty({ example: '2026-10-01' })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  effectiveDate!: string;

  @ApiProperty({ type: AmendmentChangesDto })
  @IsObject()
  @ValidateNested()
  @Type(() => AmendmentChangesDto)
  changes!: AmendmentChangesDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class UpdateAmendmentDto extends PartialType(CreateAmendmentDto) {}

export class SignAmendmentDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  signedFileId?: string;
}
