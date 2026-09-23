import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { AssetsService } from '../assets/assets.service';
import { CompleteUploadDto } from '../assets/dto/complete-upload.dto';
import { CreateUploadSessionDto } from '../assets/dto/create-upload-session.dto';
import { CreateRenderBatchDto } from './dto/create-render-batch.dto';
import { UpdateRenderProfileDto } from './dto/update-render-profile.dto';
import { RerenderWatermarkDto } from './dto/rerender-watermark.dto';
import { RenderService } from './render.service';

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
    @Body() dto: CreateUploadSessionDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.createUploadSession(dto, context.userId, context.userType);
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
