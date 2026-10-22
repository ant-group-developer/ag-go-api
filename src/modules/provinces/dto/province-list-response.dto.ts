import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProvinceCountryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  code!: string | null;
}

export class ProvinceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  countryId!: string;

  @ApiPropertyOptional({ type: ProvinceCountryDto })
  country?: ProvinceCountryDto;

  @ApiPropertyOptional({ nullable: true, type: String })
  code!: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;
}

export class ProvinceListResponseDto {
  @ApiProperty({ type: [ProvinceDto] })
  items!: ProvinceDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
