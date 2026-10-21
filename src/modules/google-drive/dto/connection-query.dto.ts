import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class StartDriveConnectionQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Frontend path to return to after Google OAuth; must be on FRONTEND_ORIGIN',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  returnUrl?: string;
}

export class DriveOAuthCallbackQueryDto {
  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty({ description: 'OAuth state issued by POST /google-drive/connection/start' })
  @IsString()
  state!: string;
}

export class StartDriveConnectionResponseDto {
  @ApiProperty()
  authorizationUrl!: string;

  @ApiProperty()
  state!: string;
}
