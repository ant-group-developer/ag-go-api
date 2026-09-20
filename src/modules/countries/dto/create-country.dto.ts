import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateCountryDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  flagUrl?: string;
}
