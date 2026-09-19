import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateProjectMediaDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;
}
