import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { Public } from '../../common/auth/public.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { AnalysisLogService } from './analysis-log.service';
import { AnalysisSignService } from './analysis-sign.service';
import { AnalysisService } from './analysis.service';
import { AnalysisLogsQueryDto } from './dto/analysis-logs-query.dto';
import { BackfillAnalysisDto } from './dto/backfill-analysis.dto';
import { EnqueueAnalysisDto } from './dto/enqueue-analysis.dto';
import { FarmTicketGuard } from './farm/farm-ticket.guard';
import { SignRequestSchema } from './farm/sign';

@ApiTags('analysis')
@Controller()
export class AnalysisController {
  constructor(
    private readonly analysisService: AnalysisService,
    private readonly analysisLog: AnalysisLogService,
    private readonly signService: AnalysisSignService,
    private readonly authContext: AuthContextService,
  ) {}

  // ---------------------------------------------------------------------------
  // Farm sign endpoint — public route guarded by FarmTicketGuard
  // ---------------------------------------------------------------------------

  @Post('analysis/farm/sign')
  @Public()
  // Workers read the ag-farm sign contract ({ results }), not the API envelope
  @RawResponse()
  @UseGuards(FarmTicketGuard)
  @ApiOperation({ summary: 'Sign storage URLs for a farm worker (Ticket auth)' })
  async farmSign(@Body() body: unknown, @Req() req: Request) {
    const parsed = SignRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid sign request: ${parsed.error.message}`);
    }
    const claims = req.farmTicketClaims!;
    const job = req.farmJob!;
    return this.signService.sign(claims, job, parsed.data.ops, req.requestId);
  }

  // ---------------------------------------------------------------------------
  // Analysis stats
  // ---------------------------------------------------------------------------

  @Get('analysis/stats')
  @ApiBearerAuth()
  @RequirePermissions(GO_PERMISSIONS.ANALYSIS_MANAGE)
  @ApiOperation({ summary: 'Analysis counts by status for assets in the given folders' })
  getStats(@Query('folderIds') folderIds?: string) {
    const ids = folderIds
      ? folderIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    return this.analysisService.getStats(ids);
  }

  // ---------------------------------------------------------------------------
  // Backfill
  // ---------------------------------------------------------------------------

  @Post('analysis/backfill')
  @ApiBearerAuth()
  @RequirePermissions(GO_PERMISSIONS.ANALYSIS_MANAGE)
  @ApiOperation({ summary: 'Enqueue analysis for a batch of assets' })
  backfill(@Body() dto: BackfillAnalysisDto, @Req() req: Request) {
    const context = this.authContext.getContext(req);
    return this.analysisService.backfill({
      folderIds: dto.folderIds,
      projectIds: dto.projectIds,
      mode: dto.mode,
      priority: dto.priority,
      dryRun: dto.dryRun,
      requestedBy: context.userId,
    });
  }

  // ---------------------------------------------------------------------------
  // Processing log
  // ---------------------------------------------------------------------------

  @Get('analysis/logs')
  @ApiBearerAuth()
  @RequirePermissions(GO_PERMISSIONS.ANALYSIS_MANAGE)
  @ApiOperation({ summary: 'Processing log of the analysis pipeline, newest first' })
  getLogs(@Query() query: AnalysisLogsQueryDto) {
    return this.analysisLog.list(query);
  }

  // ---------------------------------------------------------------------------
  // Per-asset analysis endpoints
  // ---------------------------------------------------------------------------

  @Post('assets/:assetId/analysis')
  @ApiBearerAuth()
  @RequirePermissions(GO_PERMISSIONS.ANALYSIS_MANAGE)
  @ApiOperation({ summary: 'Enqueue analysis for a single asset' })
  enqueueForAsset(
    @Param('assetId') assetId: string,
    @Body() dto: EnqueueAnalysisDto,
    @Req() req: Request,
  ) {
    const context = this.authContext.getContext(req);
    return this.analysisService.enqueueForAsset(assetId, context.userId, context.userType, {
      priority: dto.priority,
    });
  }

  @Get('assets/:assetId/analysis')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current and latest analysis for an asset' })
  getAnalysis(@Param('assetId') assetId: string, @Req() req: Request) {
    const context = this.authContext.getContext(req);
    return this.analysisService.getAnalysisForAsset(assetId, context.userId, context.userType);
  }

  @Get('assets/:assetId/segments')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current segments for an asset' })
  getSegments(@Param('assetId') assetId: string, @Req() req: Request) {
    const context = this.authContext.getContext(req);
    return this.analysisService.getSegmentsForAsset(assetId, context.userId, context.userType);
  }

  // ---------------------------------------------------------------------------
  // Project analysis status
  // ---------------------------------------------------------------------------

  @Get('projects/:projectId/analysis-status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get analysis status for all media in a project' })
  getProjectAnalysisStatus(@Param('projectId') projectId: string, @Req() req: Request) {
    const context = this.authContext.getContext(req);
    return this.analysisService.getProjectAnalysisStatus(
      projectId,
      context.userId,
      context.userType,
    );
  }
}
