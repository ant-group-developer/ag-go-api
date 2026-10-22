import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** A bundle of originals: the picked folders (subfolders included) × the picked categories. */
export class SaveOriginalAccessBundleDto {
  @ApiPropertyOptional({ description: 'Người nhận; bắt buộc khi tạo, bỏ qua khi sửa' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  principalId?: string;

  @ApiProperty({ type: [String], format: 'uuid', description: 'Ít nhất một thư mục' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsUUID('all', { each: true })
  folderIds!: string[];

  @ApiProperty({ type: [String], format: 'uuid', description: 'Ít nhất một danh mục' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  categoryIds!: string[];
}

/** What a bundle would give, before saving it; empty lists are allowed while picking. */
export class PreviewOriginalAccessBundleDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(5000)
  @IsUUID('all', { each: true })
  folderIds!: string[];

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  categoryIds!: string[];
}
