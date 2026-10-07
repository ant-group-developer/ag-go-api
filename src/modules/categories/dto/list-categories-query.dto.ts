import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class ListCategoriesQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Only the categories granted to the current user (all for admins), as on the "Projects" page.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsOptional()
  @IsBoolean()
  granted?: boolean;
}
