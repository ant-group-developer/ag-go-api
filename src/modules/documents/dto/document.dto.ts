import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PRICING_MODELS, type PricingModel } from '../../../database/entities/contract.entity';
import {
  DOCUMENT_TEMPLATE_KINDS,
  type DocumentTemplateKind,
} from '../../../database/entities/document-template.entity';

export const DOCUMENT_FORMATS = ['docx', 'pdf'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** Multipart booleans arrive as strings. */
const toBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

export class UpdateCompanySettingsDto {
  @ApiPropertyOptional({ example: 'CÔNG TY CỔ PHẦN ANT GROUP' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  name?: string | null;

  @ApiPropertyOptional({ example: '0100000000', description: 'Mã số thuế' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxCode?: string | null;

  @ApiPropertyOptional({ example: 'Ông Nguyễn Văn A', description: 'Người đại diện' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  representative?: string | null;

  @ApiPropertyOptional({ example: 'Giám đốc', description: 'Chức vụ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string | null;

  @ApiPropertyOptional({ example: 'Số 1 Phố Mẫu, Hà Nội' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bankAccountNumber?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string | null;
}

export class ListTemplatesQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_TEMPLATE_KINDS })
  @IsOptional()
  @IsIn(DOCUMENT_TEMPLATE_KINDS)
  kind?: DocumentTemplateKind;

  @ApiPropertyOptional({ enum: PRICING_MODELS })
  @IsOptional()
  @IsIn(PRICING_MODELS)
  pricingModel?: PricingModel;
}

export class PlaceholdersQueryDto {
  @ApiProperty({ enum: DOCUMENT_TEMPLATE_KINDS })
  @IsIn(DOCUMENT_TEMPLATE_KINDS)
  kind!: DocumentTemplateKind;
}

/** Fields of `POST /contract-templates` (multipart, with `file`). */
export class UploadTemplateDto {
  @ApiProperty({ enum: DOCUMENT_TEMPLATE_KINDS })
  @IsIn(DOCUMENT_TEMPLATE_KINDS)
  kind!: DocumentTemplateKind;

  @ApiPropertyOptional({
    enum: PRICING_MODELS,
    description: 'Bắt buộc với HĐ; bỏ trống với phụ lục / BBNT = dùng cho mọi mô hình giá',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
  @IsIn(PRICING_MODELS)
  pricingModel?: PricingModel;

  @ApiPropertyOptional({ example: 'HĐ package_tier 11/2026' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({ default: true, description: 'Dùng phiên bản này cho lần phát hành sau' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  activate?: boolean;
}

export class ValidateTemplateDto {
  @ApiProperty({ enum: DOCUMENT_TEMPLATE_KINDS })
  @IsIn(DOCUMENT_TEMPLATE_KINDS)
  kind!: DocumentTemplateKind;
}

export class DocumentContentQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_FORMATS, default: 'docx' })
  @IsOptional()
  @IsIn(DOCUMENT_FORMATS)
  format?: DocumentFormat;

  @ApiPropertyOptional({
    default: false,
    description: 'true: Content-Disposition attachment (tải về) thay vì inline (xem)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  download?: boolean;
}

export class PreviewQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_FORMATS, default: 'docx' })
  @IsOptional()
  @IsIn(DOCUMENT_FORMATS)
  format?: DocumentFormat;
}
