import { ApiProperty, OmitType } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { CreateUploadSessionDto } from '../../assets/dto/create-upload-session.dto';

export const WATERMARK_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export class CreateWatermarkLogoUploadSessionDto extends OmitType(CreateUploadSessionDto, [
  'assetType',
  'targetProjectId',
  'mimeType',
] as const) {
  @ApiProperty({ enum: WATERMARK_LOGO_MIME_TYPES })
  @IsIn(WATERMARK_LOGO_MIME_TYPES)
  mimeType!: (typeof WATERMARK_LOGO_MIME_TYPES)[number];
}
