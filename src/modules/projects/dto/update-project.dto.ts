import { IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdateProjectDto {
  @IsOptional()
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsUUID()
  countryId?: string | null;

  @IsOptional()
  @IsUUID()
  provinceId?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];
}
