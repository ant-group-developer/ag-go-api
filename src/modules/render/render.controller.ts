import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { AssetsService } from '../assets/assets.service';
import { CompleteUploadDto } from '../assets/dto/complete-upload.dto';
import { CreateRenderBatchDto } from './dto/create-render-batch.dto';
import { CreateWatermarkLogoUploadSessionDto } from './dto/create-watermark-logo-upload-session.dto';
import { RerenderWatermarkDto } from './dto/rerender-watermark.dto';
import { UpdateRenderProfileDto } from './dto/update-render-profile.dto';
import { isAutoJobSortField, isAutoJobStatusFilter, RenderService } from './render.service';

@ApiTags('render')
@ApiBearerAuth()
@Controller()
export class RenderController {
  constructor(
    private readonly renderService: RenderService,
    private readonly authContext: AuthContextService,
    private readonly assetsService: AssetsService,
  ) {}

  @Get('render-profiles')
  @RequirePermissions(GO_PERMISSIONS.RENDER_READ)
  listProfiles() {
    return this.renderService.listProfiles();
  }

  @Patch('render-profiles/:id')
  @RequirePermissions(GO_PERMISSIONS.SETTINGS_MANAGE)
  updateProfile(
    @Param('id') id: string,
    @Body() dto: UpdateRenderProfileDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.renderService.updateProfile(id, dto, context.userId);
  }

  @Post('render-watermark/upload-session')
  @RequirePermissions(GO_PERMISSIONS.SETTINGS_MANAGE)
  createWatermarkUploadSession(
    @Body() dto: CreateWatermarkLogoUploadSessionDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.createWatermarkLogoUploadSession(dto, context.userId);
  }

  @Get('render-watermark/logos/:assetId/url')
  @RequirePermissions(GO_PERMISSIONS.SETTINGS_MANAGE)
  getWatermarkLogoUrl(@Param('assetId', ParseUUIDPipe) assetId: string) {
    return this.assetsService.getWatermarkLogoUrl(assetId);
  }

  @Post('render-watermark/assets/:assetId/complete')
  @RequirePermissions(GO_PERMISSIONS.SETTINGS_MANAGE)
  completeWatermarkUpload(
    @Param('assetId') assetId: string,
    @Body() dto: CompleteUploadDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.completeUpload(assetId, dto, context.userId, context.userType);
  }

  @Post('render-watermark/assets/:assetId/abort')
  @RequirePermissions(GO_PERMISSIONS.SETTINGS_MANAGE)
  abortWatermarkUpload(
    @Param('assetId') assetId: string,
    @Body() dto: CompleteUploadDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.abortUpload(
      assetId,
      dto.uploadSessionId,
      context.userId,
      context.userType,
    );
  }

  @Post('render-batches')
  @RequirePermissions(GO_PERMISSIONS.RENDER_BATCH)
  createBatch(@Body() dto: CreateRenderBatchDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.createBatch(dto, context.userId, context.userType);
  }

  @Get('render-batches')
  @RequirePermissions(GO_PERMISSIONS.RENDER_READ)
  listAllBatches(@Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.listAllBatches(context.userId, context.userType);
  }

  @Get('projects/:projectId/render-batches')
  @RequirePermissions(GO_PERMISSIONS.RENDER_READ)
  listBatches(@Param('projectId') projectId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.listBatches(projectId, context.userId, context.userType);
  }

  @Get('render-batches/:id/jobs')
  @RequirePermissions(GO_PERMISSIONS.RENDER_READ)
  listJobs(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.listJobs(id, context.userId, context.userType);
  }

  /** Jobs queued automatically after an upload or a Drive import (not part of a batch). */
  @Get('render-jobs/auto')
  @RequirePermissions(GO_PERMISSIONS.RENDER_READ)
  listAutoJobs(
    @Query('projectId') projectId: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Query('status') status: string | undefined,
    @Query('search') search: string | undefined,
    @Query('sortBy') sortBy: string | undefined,
    @Query('sortOrder') sortOrder: string | undefined,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    const parsedPage = page ? Number.parseInt(page, 10) : undefined;
    const parsedPageSize = pageSize ? Number.parseInt(pageSize, 10) : undefined;
    const normalizedSortOrder = sortOrder?.toUpperCase();
    return this.renderService.listAutoJobs(context.userId, context.userType, {
      ...(projectId ? { projectId } : {}),
      ...(Number.isFinite(parsedPage) ? { page: parsedPage } : {}),
      ...(Number.isFinite(parsedPageSize) ? { pageSize: parsedPageSize } : {}),
      ...(isAutoJobStatusFilter(status) ? { status } : {}),
      ...(search?.trim() ? { search: search.trim().slice(0, 200) } : {}),
      ...(isAutoJobSortField(sortBy) ? { sortBy } : {}),
      ...(normalizedSortOrder === 'ASC' || normalizedSortOrder === 'DESC'
        ? { sortOrder: normalizedSortOrder }
        : {}),
    });
  }

  @Post('render-jobs/:id/retry')
  @RequirePermissions(GO_PERMISSIONS.RENDER_BATCH)
  retryJob(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.retryJob(id, context.userId, context.userType);
  }

  @Post('render-watermark/rerender')
  @RequirePermissions(GO_PERMISSIONS.RENDER_BATCH)
  rerenderWatermark(@Body() dto: RerenderWatermarkDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.rerenderWatermark(dto, context.userId, context.userType);
  }

  @Get('render-batches/:id')
  @RequirePermissions(GO_PERMISSIONS.RENDER_READ)
  getBatch(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.getBatch(id, context.userId, context.userType);
  }

  @Post('render-batches/:id/cancel')
  @RequirePermissions(GO_PERMISSIONS.RENDER_BATCH)
  cancelBatch(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.cancelBatch(id, context.userId, context.userType);
  }
}
