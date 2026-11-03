import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BaseKeywordQueryDto } from '../../../common/dto/base-keyword-query.dto';
import {
  PACKAGE_STATUSES,
  type PackageStatus,
} from '../../../database/entities/product-package.entity';

export class ListPackagesQueryDto extends BaseKeywordQueryDto {
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
  categoryId?: string;

  @ApiPropertyOptional({ enum: PACKAGE_STATUSES })
  @IsOptional()
  @IsIn(PACKAGE_STATUSES)
  status?: PackageStatus;

  @ApiPropertyOptional({
    description: 'Chỉ gói của chính mình (CTV, "my-projects")',
    type: Boolean,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  mine?: boolean;

  @ApiPropertyOptional({
    description: 'Sẵn sàng lập BBNT: evaluated và chưa thuộc BBNT nào (FR-K-07)',
    type: Boolean,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  readyForAcceptance?: boolean;
}

export class CreatePackageDto {
  @ApiProperty({ format: 'uuid', description: 'Sản phẩm (danh mục) thuộc category_ids của HĐ' })
  @IsUUID()
  categoryId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'HĐ package_tier đang active. CTV bỏ trống được khi chỉ có một HĐ hiệu lực có danh mục này',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'Khám phá Đà Lạt đợt 2' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class UpdatePackageDto {
  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string | null;
}

export class ReturnPackageDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}
