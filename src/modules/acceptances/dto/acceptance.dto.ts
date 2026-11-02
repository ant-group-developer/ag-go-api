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
} from 'class-validator';
import { BaseKeywordQueryDto } from '../../../common/dto/base-keyword-query.dto';
import {
  ACCEPTANCE_STATUSES,
  DELIVERY_METHODS,
  type AcceptanceStatus,
  type DeliveryMethod,
} from '../../../database/entities/acceptance.entity';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property phải có dạng YYYY-MM-DD';
const MAX_MONEY = 1e15;

export class ListAcceptancesQueryDto extends BaseKeywordQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ enum: ACCEPTANCE_STATUSES })
  @IsOptional()
  @IsIn(ACCEPTANCE_STATUSES)
  status?: AcceptanceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  managerUserId?: string;
}

export class EligibleQueryDto {
  @ApiProperty({
    example: '2026-07-31',
    description: 'Ngày cuối kỳ (giá và điều khoản theo ngày này)',
  })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  periodEnd!: string;
}

export class CreateAcceptanceDto {
  @ApiProperty({ example: '2026-07-01' })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  periodStart!: string;

  @ApiProperty({
    example: '2026-07-31',
    description: 'Giá theo phiên bản bảng giá hiệu lực ngày này (Q-R1)',
  })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  periodEnd!: string;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Ngày lập ghi trên biên bản' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  recordDate?: string;

  @ApiPropertyOptional({ enum: DELIVERY_METHODS, default: 'ag_go' })
  @IsOptional()
  @IsIn(DELIVERY_METHODS)
  deliveryMethod?: DeliveryMethod;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  deliveryNote?: string;

  @ApiPropertyOptional({ example: 10, description: 'Thuế TNCN (%), mặc định 10 (BR-30)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;
}

export class UpdateAcceptanceDto {
  @ApiPropertyOptional({ example: '2026-07-01' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  periodStart?: string;

  @ApiPropertyOptional({ example: '2026-07-31', description: 'Đổi thì tính lại' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  periodEnd?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  recordDate?: string | null;

  @ApiPropertyOptional({ enum: DELIVERY_METHODS })
  @IsOptional()
  @IsIn(DELIVERY_METHODS)
  deliveryMethod?: DeliveryMethod;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  deliveryNote?: string | null;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Thuế nhập tay (đồng); null = tính theo tỷ lệ. Cần taxOverrideReason',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  taxAmount?: number | null;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  taxOverrideReason?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Đối trừ tạm ứng nhập tay (đồng); null = tính theo BR-32. Cần advanceOffsetReason',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  advanceOffsetAmount?: number | null;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  advanceOffsetReason?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Dự án bỏ khỏi BBNT nháp (thay toàn bộ, FR-A-04); tính lại',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsUUID('all', { each: true })
  excludedProjectIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Gói bỏ khỏi BBNT nháp (thay toàn bộ); tính lại',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  excludedPackageIds?: string[];
}

export class AdjustItemDto {
  @ApiPropertyOptional({ example: 12, description: 'Khối lượng cuối (2 chữ số lẻ)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999)
  quantity?: number;

  @ApiPropertyOptional({ example: 300000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9_999_999_999_999)
  unitPrice?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  productLabel?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Bắt buộc khi khối lượng / đơn giá khác giá trị hệ thống tính (BR-14)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class AcceptanceReasonDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}

export class ApproveAcceptanceDto {
  @ApiPropertyOptional({
    maxLength: 2000,
    description:
      'Bắt buộc khi BBNT còn cảnh báo (80/20, tụt Mức…): quyết định của người duyệt (Q-R3)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class SignAcceptanceDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Bản ký đã tải lên (chứng từ, PR sau)' })
  @IsOptional()
  @IsUUID()
  signedFileId?: string;

  @ApiPropertyOptional({
    example: '2026-08-05',
    description: 'Ngày ký, mặc định hôm nay; tính hạn thanh toán (BR-34)',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  signedDate?: string;
}
