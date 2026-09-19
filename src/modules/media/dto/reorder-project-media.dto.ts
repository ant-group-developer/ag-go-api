import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class ReorderProjectMediaDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  mediaIds!: string[];
}
