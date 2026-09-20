import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
