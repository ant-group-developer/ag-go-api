import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WebSettingsDto {
  @ApiProperty()
  siteName!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  siteDescription?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  logoUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  faviconUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  loginBackgroundUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  supportEmail?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  supportUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  primaryColor?: string | null;
}
