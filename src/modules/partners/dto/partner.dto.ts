import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { BaseKeywordQueryDto } from '../../../common/dto/base-keyword-query.dto';
import { PARTNER_STATUSES, type PartnerStatus } from '../../../database/entities/partner.entity';
import { PARTNER_CODE_PATTERN } from '../partner-code';

export const PARTNER_PROFILE_STATES = ['complete', 'incomplete', 'unchecked'] as const;
export type PartnerProfileState = (typeof PARTNER_PROFILE_STATES)[number];

export class ListPartnersQueryDto extends BaseKeywordQueryDto {
  @ApiPropertyOptional({ enum: PARTNER_STATUSES })
  @IsOptional()
  @IsIn(PARTNER_STATUSES)
  status?: PartnerStatus;

  @ApiPropertyOptional({ description: 'Người phụ trách (AG Go user id)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  managerUserId?: string;

  @ApiPropertyOptional({
    enum: PARTNER_PROFILE_STATES,
    description: 'Kết quả lần kiểm tra hồ sơ gần nhất (không gọi AG Account)',
  })
  @IsOptional()
  @IsIn(PARTNER_PROFILE_STATES)
  profile?: PartnerProfileState;
}

export class CreatePartnerDto {
  @ApiProperty({
    description:
      'AG Go user id của đối tác (sub đã bỏ `auth0|`, như projects.owner_user_id). AG Go tự lấy id AG Account qua by-sub.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  goUserId!: string;

  @ApiPropertyOptional({
    description:
      'Id AG Account đã chọn ở danh sách ứng viên; gửi kèm để kiểm tra khớp với goUserId (lệch → 400)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  accountUserId?: string;

  @ApiPropertyOptional({
    description: 'Mã đối tác dùng trong số HĐ; bỏ trống = chữ cái đầu họ tên (BR-06)',
    example: 'NHH',
  })
  @IsOptional()
  @Matches(PARTNER_CODE_PATTERN, { message: 'code chỉ gồm chữ in hoa và số, tối đa 20 ký tự' })
  code?: string;

  @ApiPropertyOptional({ description: 'Người phụ trách; mặc định là người tạo' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  managerUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class UpdatePartnerDto {
  @ApiPropertyOptional({ example: 'NHH' })
  @IsOptional()
  @Matches(PARTNER_CODE_PATTERN, { message: 'code chỉ gồm chữ in hoa và số, tối đa 20 ký tự' })
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  managerUserId?: string;

  @ApiPropertyOptional({ enum: PARTNER_STATUSES })
  @IsOptional()
  @IsIn(PARTNER_STATUSES)
  status?: PartnerStatus;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

export class PartnerProfileQueryDto {
  @ApiPropertyOptional({
    enum: ['pii'],
    description: 'pii = trả giá trị đầy đủ (cần go.partner.pii_read, ghi audit)',
  })
  @IsOptional()
  @IsIn(['pii'])
  reveal?: 'pii';
}
