import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { Request } from 'express';
import { AuthContextService } from '../../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../../common/auth/permissions.constants';
import { RequirePermissions } from '../../../common/auth/permissions.decorator';
import { PrepService } from './prep.service';

export class PrepBackfillDto {
  @ApiProperty({ enum: ['missing', 'all'] })
  @IsIn(['missing', 'all'])
  mode!: 'missing' | 'all';

  @ApiPropertyOptional({
    default: false,
    description: 'Only count the footage that would be queued',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** Studio inputs prepared in ag-go (preps): progress and backfill, for the analysis page. */
@ApiTags('prep')
@ApiBearerAuth()
@Controller('prep')
@RequirePermissions(GO_PERMISSIONS.ANALYSIS_MANAGE)
export class PrepController {
  constructor(
    private readonly prepService: PrepService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Footage by prep state, and the latest prep backfills' })
  stats() {
    return this.prepService.stats();
  }

  @Post('backfill')
  @ApiOperation({ summary: 'Queue a prep (lane batch) for footage without one, or for all of it' })
  backfill(@Body() dto: PrepBackfillDto, @Req() req: Request) {
    return this.prepService.backfill({
      mode: dto.mode,
      dryRun: dto.dryRun,
      requestedBy: this.authContext.getContext(req).userId,
    });
  }

  @Post('batches/:batchId/pause')
  @ApiOperation({ summary: 'Pause a prep backfill' })
  pause(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.prepService.pause(batchId);
  }

  @Post('batches/:batchId/resume')
  @ApiOperation({ summary: 'Resume a paused prep backfill' })
  resume(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.prepService.resume(batchId);
  }

  @Post('batches/:batchId/cancel')
  @ApiOperation({ summary: 'Cancel everything unfinished in a prep backfill' })
  cancel(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.prepService.cancel(batchId);
  }
}
