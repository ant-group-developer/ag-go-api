import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

export const DOWNLOAD_SCOPES = ['single', 'multiple', 'project', 'projects'] as const;
export type DownloadScope = (typeof DOWNLOAD_SCOPES)[number];

/** Most projects one `projects` download may bundle into a single ZIP. */
export const MAX_DOWNLOAD_PROJECTS = 100;

export class CreateDownloadDto {
  @IsIn(DOWNLOAD_SCOPES)
  scope!: DownloadScope;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  projectMediaIds?: string[];

  /** Every file of these projects, for the `projects` scope. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DOWNLOAD_PROJECTS)
  @IsUUID(undefined, { each: true })
  projectIds?: string[];

  @IsIn(['original', 'rendered'])
  downloadType!: 'original' | 'rendered';
}
