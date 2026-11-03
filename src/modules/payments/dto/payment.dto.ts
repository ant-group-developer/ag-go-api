import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { BaseListQueryDto } from '../../../common/dto/base-list-query.dto';
import {
  ACCEPTANCE_STATUSES,
  type AcceptanceStatus,
} from '../../../database/entities/acceptance.entity';
import {
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type PaymentKind,
  type PaymentMethod,
  type PaymentStatus,
} from '../../../database/entities/payment.entity';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property phải có dạng YYYY-MM-DD';
const MAX_MONEY = 999_999_999_999_999;

export class CreatePaymentDto {
  @ApiProperty({
    enum: PAYMENT_KINDS,
    description:
      'advance: chi tạm ứng (FR-$-01); settlement: chi trả BBNT đã ký (cần acceptanceId, FR-$-02); refund: đối tác hoàn tạm ứng (FR-C-10)',
  })
  @IsIn(PAYMENT_KINDS)
  kind!: PaymentKind;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'BBNT được chi trả (bắt buộc với settlement)',
  })
  @ValidateIf(
    (dto: CreatePaymentDto) => dto.kind === 'settlement' || dto.acceptanceId !== undefined,
  )
  @IsUUID()
  acceptanceId?: string;

  @ApiProperty({ example: 50_000_000, description: 'Số tiền (đồng), > 0' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MONEY)
  amount!: number;

  @ApiProperty({
    example: '2026-08-05',
    description: 'Ngày chi / ngày nhận hoàn, không sau hôm nay',
  })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  paidDate!: string;

  @ApiPropertyOptional({ enum: PAYMENT_METHODS, default: 'bank_transfer' })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  method?: PaymentMethod;

  @ApiPropertyOptional({ maxLength: 200, description: 'Mã giao dịch ngân hàng' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class CancelPaymentDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}

export class ListPaymentsQueryDto extends BaseListQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  acceptanceId?: string;

  @ApiPropertyOptional({ enum: PAYMENT_KINDS })
  @IsOptional()
  @IsIn(PAYMENT_KINDS)
  kind?: PaymentKind;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: PaymentStatus;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Ngày chi từ (gồm)' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31', description: 'Ngày chi đến (gồm)' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  to?: string;
}

/** Filters shared by the reports: partner, manager, and the period of the report. */
export class PaymentReportQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({ description: 'Người phụ trách HĐ' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  managerUserId?: string;

  @ApiPropertyOptional({ example: '2026-01-01', description: 'Từ ngày (gồm)' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31', description: 'Đến ngày (gồm)' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  to?: string;
}

export class OverdueQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({ example: '2026-11-03', description: 'Ngày xét quá hạn, mặc định hôm nay' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  asOf?: string;
}

export class AcceptanceStatusReportQueryDto extends PaymentReportQueryDto {
  @ApiPropertyOptional({
    enum: ACCEPTANCE_STATUSES,
    description: 'Chỉ liệt kê BBNT ở trạng thái này',
  })
  @IsOptional()
  @IsIn(ACCEPTANCE_STATUSES)
  status?: AcceptanceStatus;
}

export class TaxReportQueryDto {
  @ApiProperty({ example: 2026, description: 'Năm (theo ngày lập BBNT), FR-R-04' })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;
}

export const PAYMENT_REPORTS = ['payables', 'payments', 'acceptances', 'tax'] as const;
export type PaymentReport = (typeof PAYMENT_REPORTS)[number];

export class ReportExportQueryDto extends AcceptanceStatusReportQueryDto {
  @ApiProperty({ enum: PAYMENT_REPORTS })
  @IsIn(PAYMENT_REPORTS)
  report!: PaymentReport;

  @ApiPropertyOptional({ example: 2026, description: 'Bắt buộc với report=tax' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

export class PayoutExportQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'Chỉ BBNT có hạn thanh toán đến ngày này (gồm)',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  dueTo?: string;

  @ApiPropertyOptional({
    description:
      'true: số tài khoản, MST đầy đủ (cần go.partner.pii_read, ghi audit); mặc định che như màn hình',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  reveal?: boolean;
}
