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
import { PrepAssetsDto } from './prep-assets.dto';
import { ResolveAssetsDto } from './resolve-assets.dto';

/** `POST /footage/projects/access`: the projects AG Studio asks about for the acted-as user. */
export class FootageProjectAccessDto {
  @ApiProperty({ type: [String], description: 'Project IDs (1–200).' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  projectIds!: string[];
}

/**
 * `POST /footage/studio/assets/resolve`. AG Studio's trusted mode serves the videos of
 * `projectIds` (the projects added to one of its projects) only.
 */
export class StudioResolveAssetsDto extends ResolveAssetsDto {
  @ApiProperty({
    type: [String],
    description: 'Projects added to the AG Studio project (1–500): only their videos are served.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  projectIds!: string[];
}

/** `POST /footage/studio/assets/prep` and `.../prep/run`. */
export class StudioPrepAssetsDto extends PrepAssetsDto {
  @ApiProperty({
    type: [String],
    description: 'Projects added to the AG Studio project (1–500): only their videos are served.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  projectIds!: string[];

  @ApiPropertyOptional({ description: 'AG Studio user who asked for the prep (for its record).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestedBy?: string;
}
