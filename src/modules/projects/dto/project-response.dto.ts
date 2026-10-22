import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProjectOwnerUserDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  email?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatar?: string | null;
}

export class ProjectDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  folderId!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  folderName?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  folderPath?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', type: String })
  categoryId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  categoryName?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', type: String })
  countryId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  countryName?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  countryFlagUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', type: String })
  provinceId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  provinceName?: string | null;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  description?: string | null;

  @ApiProperty({
    enum: ['draft', 'pending', 'completed', 'partially_completed', 'failed'],
  })
  evaluationStatus!: 'draft' | 'pending' | 'completed' | 'partially_completed' | 'failed';

  @ApiProperty()
  mediaCount!: number;

  @ApiProperty()
  imageCount!: number;

  @ApiProperty()
  videoCount!: number;

  @ApiPropertyOptional({ type: String })
  originalBytes?: string;

  @ApiPropertyOptional({ type: String })
  renderedBytes?: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', type: String })
  thumbnailProjectMediaId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', type: String })
  thumbnailAssetId?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ['manual', 'auto'] })
  thumbnailSource?: 'manual' | 'auto' | null;

  @ApiProperty()
  ownerUserId!: string;

  @ApiPropertyOptional({ nullable: true, type: () => ProjectOwnerUserDto })
  ownerUser?: ProjectOwnerUserDto | null;

  @ApiPropertyOptional({ type: [String] })
  tagIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  tags?: string[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class ProjectPageDto {
  @ApiProperty({ type: [ProjectDto] })
  items!: ProjectDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
