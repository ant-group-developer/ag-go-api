import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class AccountUserQueryDto {
  @ApiPropertyOptional({
    description: 'Các trường user muốn lấy từ Account API, phân cách bằng dấu phẩy.',
    example: 'id,name,email,avatar',
  })
  @IsOptional()
  @IsString()
  fields?: string;
}
