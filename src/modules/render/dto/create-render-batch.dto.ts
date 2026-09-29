import { IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class CreateRenderBatchDto {
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  projectMediaIds?: string[];

  @IsOptional()
  @IsUUID()
  renderProfileId?: string;

  /**
   * Keep variants that already match the profile and render only the missing or changed ones
   * (default). False renders every variant again.
   */
  @IsOptional()
  @IsBoolean()
  reuseExisting?: boolean;
}
