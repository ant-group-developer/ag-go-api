import { IsEmail, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

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
}
