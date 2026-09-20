import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateProjectMediaDto {
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;

  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'] })
  @IsOptional()
  @IsEnum(['pending', 'approved', 'rejected'])
  evaluationStatus?: 'pending' | 'approved' | 'rejected';

  @ApiPropertyOptional({ type: String, maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}
