import { IsString, MaxLength } from 'class-validator';

export class UpdateTagDto {
  @IsString()
  @MaxLength(100)
  name!: string;
}
