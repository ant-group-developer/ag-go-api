import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(220)
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
