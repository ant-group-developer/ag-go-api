import { ApiProperty } from '@nestjs/swagger';

export class CursorListResponseDto<T> {
  @ApiProperty({ isArray: true })
  items: T[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor: string | null;

  constructor(items: T[], nextCursor: string | null = null) {
    this.items = items;
    this.nextCursor = nextCursor;
  }
}
