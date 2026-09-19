import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class CompleteUploadDto {
  @IsUUID()
  uploadSessionId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  checksumSha256?: string;
}
