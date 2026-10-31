import { IsEmail, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';

const MIB = 1024 * 1024;
/** R2 and S3 reject objects above 5 TiB. */
const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * MIB;

export class UpdateSettingsDto {
  @IsString()
  @MaxLength(160)
  siteName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  siteDescription?: string | null;

  @IsOptional()
  @IsUrl()
  logoUrl?: string | null;

  @IsOptional()
  @IsUrl()
  faviconUrl?: string | null;

  @IsOptional()
  @IsUrl()
  loginBackgroundUrl?: string | null;

  @IsOptional()
  @IsEmail()
  supportEmail?: string | null;

  @IsOptional()
  @IsUrl()
  supportUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  primaryColor?: string | null;

  /** Per-file upload limit; null resets it to MAX_UPLOAD_SIZE_BYTES. */
  @IsOptional()
  @IsInt()
  @Min(MIB)
  @Max(MAX_OBJECT_BYTES)
  maxUploadSizeBytes?: number | null;
}
