import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(220)
  slug!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class CreateCountryDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;

  @IsString()
  @MaxLength(200)
  name!: string;
}

export class CreateProvinceDto {
  @IsUUID()
  countryId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsString()
  @MaxLength(200)
  name!: string;
}

export class CreateTagDto {
  @IsString()
  @MaxLength(100)
  name!: string;
}
