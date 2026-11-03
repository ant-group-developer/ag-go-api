import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { BaseListQueryDto } from '../../../common/dto/base-list-query.dto';

export class UpdateProjectContractDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'HĐ active của đúng đối tác sở hữu project (FR-C-08); null = bỏ gắn; bỏ trống = giữ nguyên',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string | null;

  @ApiPropertyOptional({
    example: '2026-09-14T10:00:00+07:00',
    description:
      'Sửa thời điểm giao (mặc định là lần đầu project chuyển "pending"); cần go.contract.manage',
  })
  @IsOptional()
  @IsDateString()
  deliveredAt?: string;

  @ApiPropertyOptional({
    description:
      'Đánh dấu / bỏ đánh dấu "đã nghiệm thu ngoài hệ thống" (mục 15.3): không kiểm tra, không tính lại; cần go.contract.manage',
  })
  @IsOptional()
  @IsBoolean()
  acceptedOutside?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Ghi chú, vd. số BBNT giấy' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  acceptedOutsideNote?: string | null;
}

export const LINK_FILTERS = ['all', 'linked', 'unlinked'] as const;
export type LinkFilter = (typeof LINK_FILTERS)[number];

export class ListPartnerProjectsQueryDto extends BaseListQueryDto {
  @ApiPropertyOptional({
    enum: LINK_FILTERS,
    default: 'all',
    description: 'unlinked = chưa gắn HĐ (vd. đối tác có nhiều HĐ hiệu lực, cần chọn)',
  })
  @IsOptional()
  @IsIn(LINK_FILTERS)
  link?: LinkFilter;

  @ApiPropertyOptional({ description: 'Chỉ project đã giao (delivered_at có giá trị)' })
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'])
  delivered?: 'true' | 'false';
}

export class ListContractProjectsQueryDto extends BaseListQueryDto {}
