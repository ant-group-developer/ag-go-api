import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AssetPreviewQueryDto {
  @ApiPropertyOptional({ minimum: 1, description: 'Requested preview width in pixels' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  width?: number;
}

export class AssetPreviewUrlQueryDto extends AssetPreviewQueryDto {
  @ApiPropertyOptional({ default: 'thumbnail' })
  @IsOptional()
  @IsString()
  variantCode = 'thumbnail';
}
