import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/** `POST /footage/assets/prep` and `.../prep/run`: the footage AG Studio prepares. */
export class PrepAssetsDto {
  @ApiProperty({ type: [String], description: 'Asset (video) IDs (1–200).' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  assetIds!: string[];
}
