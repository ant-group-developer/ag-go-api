import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetsService } from './assets.service';
import { AbortUploadDto } from './dto/abort-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';

@ApiTags('assets')
@ApiBearerAuth()
@Controller()
export class AssetsController {
  constructor(
    private readonly assetsService: AssetsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Post('assets/upload-session')
  createUploadSession(
    @Body() dto: CreateUploadSessionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.createUploadSession(dto, context.userId, idempotencyKey);
  }

  @Post('assets/:assetId/complete')
  completeUpload(
    @Param('assetId') assetId: string,
    @Body() dto: CompleteUploadDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.completeUpload(assetId, dto, context.userId);
  }

  @Post('assets/:assetId/abort')
  abortUpload(
    @Param('assetId') assetId: string,
    @Body() dto: AbortUploadDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.abortUpload(assetId, dto.uploadSessionId, context.userId);
  }

  @Get('assets/:assetId/variants')
  listVariants(@Param('assetId') assetId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.assetsService.listVariants(assetId, context.userId);
  }

  @Get('assets/:assetId/preview/:variantCode')
  preview(
    @Param('assetId') assetId: string,
    @Param('variantCode') variantCode: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.preview(assetId, variantCode, context.userId, response);
  }

  @Get('assets/:assetId/preview-url')
  @ApiOperation({ summary: 'Tạo presigned URL để tải preview trực tiếp từ R2' })
  previewUrl(
    @Param('assetId') assetId: string,
    @Query('variantCode') variantCode = 'thumbnail',
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.getPreviewUrl(assetId, variantCode, context.userId);
  }

  @Post('assets/:assetId/retry')
  retry(@Param('assetId') assetId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.assetsService.retry(assetId, context.userId);
  }
}
