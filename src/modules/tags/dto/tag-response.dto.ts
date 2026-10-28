import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TagActorDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  email?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatar?: string | null;
}

export class TagDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional()
  normalizedName?: string;

  @ApiPropertyOptional()
  createdBy?: string;

  @ApiPropertyOptional({ nullable: true, type: () => TagActorDto })
  createdByUser?: TagActorDto | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  createdAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  updatedAt?: string | null;
}
