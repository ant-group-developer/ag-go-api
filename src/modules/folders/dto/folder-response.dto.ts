import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FolderActorDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  email?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatar?: string | null;
}

export class FolderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', type: String })
  parentId?: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  pathText!: string;

  @ApiPropertyOptional({ type: [String] })
  pathIds?: string[];

  @ApiProperty()
  depth!: number;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;

  @ApiPropertyOptional()
  childCount?: number;

  @ApiPropertyOptional()
  projectCount?: number;

  @ApiPropertyOptional({ enum: ['viewer', 'editor', 'manager'] })
  myAccessLevel?: 'viewer' | 'editor' | 'manager';

  @ApiPropertyOptional()
  createdBy?: string;

  @ApiPropertyOptional({ nullable: true, type: () => FolderActorDto })
  createdByUser?: FolderActorDto | null;

  @ApiPropertyOptional({ format: 'date-time' })
  createdAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  updatedAt?: string;
}

export class FolderOptionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', type: String })
  parentId?: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  pathText!: string;

  @ApiPropertyOptional({ type: [String] })
  pathIds?: string[];

  @ApiProperty()
  depth!: number;
}
