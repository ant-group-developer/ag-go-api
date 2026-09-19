import { IsOptional, IsUUID } from 'class-validator';

export class SetProjectThumbnailDto {
  @IsOptional()
  @IsUUID()
  projectMediaId?: string | null;
}
