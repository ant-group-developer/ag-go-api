import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class ListCategoriesQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Only the categories of the "Projects" page of the current user (all for admins), ' +
      'granted to them or of an evaluated project in their folders.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsOptional()
  @IsBoolean()
  granted?: boolean;
}
