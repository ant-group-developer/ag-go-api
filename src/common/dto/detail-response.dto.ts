import { ApiProperty } from '@nestjs/swagger';

export class DetailResponseDto<T> {
  @ApiProperty()
  data: T;

  constructor(data: T) {
    this.data = data;
  }
}
