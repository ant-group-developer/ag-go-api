import { IsBoolean, IsIn, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpsertFolderGrantDto {
  @IsIn(['user', 'group'])
  principalType!: 'user' | 'group';

  @IsString()
  @MaxLength(128)
  principalId!: string;

  @IsIn(['viewer', 'editor', 'manager'])
  accessLevel!: 'viewer' | 'editor' | 'manager';

  @IsBoolean()
  inheritChildren = true;
}

export class FolderIdParamDto {
  @IsUUID()
  id!: string;
}
