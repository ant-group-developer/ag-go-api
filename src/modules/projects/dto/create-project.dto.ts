import { ArrayUnique, IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateProjectDto {
  @IsUUID()
  folderId!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  countryId?: string;

  @IsOptional()
  @IsUUID()
  provinceId?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  tagIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];
}
