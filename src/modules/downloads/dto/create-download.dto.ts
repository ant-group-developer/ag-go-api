import { IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

export class CreateDownloadDto {
  @IsIn(['single', 'multiple', 'project'])
  scope!: 'single' | 'multiple' | 'project';

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  projectMediaIds?: string[];

  @IsIn(['original', 'rendered'])
  downloadType!: 'original' | 'rendered';
}
