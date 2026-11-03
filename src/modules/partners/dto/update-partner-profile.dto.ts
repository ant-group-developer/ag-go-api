import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ACCOUNT_TAX_MODES } from '../../account/account.types';

// Same rules as AG Account (contract-profile-rules.ts), so most mistakes are caught here. An
// empty string, like null, clears the field.
const DATE = /^(|\d{4}-\d{2}-\d{2})$/;
const CITIZEN_ID = /^(|\d{12}|\d{9})$/;
const PHONE = /^(|0\d{9})$/;
const TAX_NUMBER = /^(|\d{10}|\d{12}|\d{13})$/;
const BANK_ACCOUNT = /^(|\d{6,19})$/;
const BANK_CODE = /^(|\d{6})$/;

/**
 * Partial update of the AG Account contract profile: only the fields sent are written; null or
 * an empty string clears; a field left out is kept. An emptied tax number takes the ID card number
 * sent with it (FR-P-04).
 */
export class UpdatePartnerProfileDto {
  @ApiProperty({
    description: '`version` từ GET /partners/:id/profile, gửi làm If-Match (lệch → 409)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  version!: string;

  @ApiPropertyOptional({ nullable: true, description: 'CCCD 12 số (CMND 9 số vẫn nhận)' })
  @IsOptional()
  @Matches(CITIZEN_ID, { message: 'citizenIdNumber phải là CCCD 12 chữ số (hoặc CMND 9 số)' })
  citizenIdNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2021-05-01' })
  @IsOptional()
  @Matches(DATE, { message: 'idIssuedDate phải có dạng YYYY-MM-DD' })
  idIssuedDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idIssuedPlace?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'MST cá nhân 10/12/13 số' })
  @IsOptional()
  @Matches(TAX_NUMBER, { message: 'taxNumber phải gồm 10, 12 hoặc 13 chữ số' })
  taxNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '0912345678' })
  @IsOptional()
  @Matches(PHONE, { message: 'phoneNumber phải gồm 10 chữ số, bắt đầu bằng 0' })
  phoneNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1990-01-31' })
  @IsOptional()
  @Matches(DATE, { message: 'birthday phải có dạng YYYY-MM-DD' })
  birthday?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  permanentAddress?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  passportNumber?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  bankAccountName?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Chỉ gồm chữ số, 6–19 ký tự' })
  @IsOptional()
  @Matches(BANK_ACCOUNT, { message: 'bankAccountNumber chỉ gồm chữ số, 6–19 ký tự' })
  bankAccountNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Mã BIN NAPAS 6 số', example: '970436' })
  @IsOptional()
  @Matches(BANK_CODE, { message: 'bankCode phải là mã BIN 6 chữ số' })
  bankCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Vietcombank' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  bankName?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ACCOUNT_TAX_MODES })
  @IsOptional()
  @IsIn([...ACCOUNT_TAX_MODES, ''])
  taxMode?: string | null;
}
