import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class SetFolderGrantDto {
  @ApiProperty({ enum: ['viewer', 'editor', 'manager'] })
  @IsIn(['viewer', 'editor', 'manager'])
  accessLevel!: 'viewer' | 'editor' | 'manager';

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  inheritChildren?: boolean;
}
