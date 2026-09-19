import { Body, Controller, Get, Headers, Param, Post, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
    return this.assetsService.createUploadSession(
      dto,
      context.userId,
      context.groupIds,
      idempotencyKey,
    );
  }

  @Put('assets/:assetId/upload-session/:sessionId/content')
  writeUpload(
    @Param('assetId') assetId: string,
    @Param('sessionId') sessionId: string,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.writeUpload(assetId, sessionId, request, context.userId);
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
    return this.assetsService.listVariants(assetId, context.userId, context.groupIds);
  }

  @Get('assets/:assetId/preview/:variantCode')
  preview(
    @Param('assetId') assetId: string,
    @Param('variantCode') variantCode: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.preview(
      assetId,
      variantCode,
      context.userId,
      context.groupIds,
      response,
    );
  }

  @Post('assets/:assetId/retry')
  retry(@Param('assetId') assetId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.assetsService.retry(assetId, context.userId, context.groupIds);
  }
}
