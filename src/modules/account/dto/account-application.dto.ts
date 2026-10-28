import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AccountApplicationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  code!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  website?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  logo?: string | null;

  @ApiPropertyOptional()
  visibility?: string;

  @ApiPropertyOptional()
  is_active?: boolean;
}
