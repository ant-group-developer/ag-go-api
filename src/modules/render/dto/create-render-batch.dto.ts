import { IsArray, IsOptional, IsUUID } from 'class-validator';

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
}
