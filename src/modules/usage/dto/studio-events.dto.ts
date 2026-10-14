import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  STUDIO_USAGE_KINDS,
  type StudioUsageKind,
} from '../../../database/entities/studio-usage-event.entity';

/** One use of footage in AG Studio (H3 contract). */
export class StudioUsageEventDto {
  @ApiProperty({ description: 'Unique per event; a resent event is not counted twice' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  eventKey!: string;

  @ApiProperty({ enum: STUDIO_USAGE_KINDS })
  @IsIn(STUDIO_USAGE_KINDS)
  kind!: StudioUsageKind;

  @ApiProperty({ description: 'ISO date-time' })
  @IsDateString()
  occurredAt!: string;

  @ApiPropertyOptional({ nullable: true, description: 'Footage; null for a whole ag-go project' })
  @IsOptional()
  @IsUUID()
  assetId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  agGoProjectId?: string | null;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  studioProjectId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(500)
  studioProjectName!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  studioVideoId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  studioVideoTitle?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Full Auth0 subject; `auth0|` is dropped' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  studioUserId?: string | null;
}

export class StudioUsageEventsDto {
  @ApiProperty({ type: [StudioUsageEventDto], description: '1–500 events' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StudioUsageEventDto)
  events!: StudioUsageEventDto[];
}
