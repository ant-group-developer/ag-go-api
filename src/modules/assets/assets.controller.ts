import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions, RequirePermissions } from '../../common/auth/permissions.decorator';
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
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  createUploadSession(
    @Body() dto: CreateUploadSessionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.createUploadSession(
      dto,
      context.userId,
      context.userType,
      idempotencyKey,
    );
  }

  @Post('assets/:assetId/complete')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  completeUpload(
    @Param('assetId') assetId: string,
    @Body() dto: CompleteUploadDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.completeUpload(assetId, dto, context.userId, context.userType);
  }

  @Post('assets/:assetId/abort')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  abortUpload(
    @Param('assetId') assetId: string,
    @Body() dto: AbortUploadDto,
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

  @Get('assets/:assetId/variants')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  listVariants(@Param('assetId') assetId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.assetsService.listVariants(assetId, context.userId, context.userType);
  }

  @Get('assets/:assetId/original-url')
  @RequireAnyPermissions(GO_PERMISSIONS.PROJECT_EVALUATE, GO_PERMISSIONS.PROJECT_DOWNLOAD_ORIGINAL)
  @ApiOperation({ summary: 'Presigned URL file gốc (không watermark) để đánh giá media' })
  originalUrl(@Param('assetId') assetId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.assetsService.getOriginalUrl(assetId, context.userId, context.userType);
  }

  @Get('assets/:assetId/renditions')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOperation({ summary: 'Các kích thước preview (có watermark) người xem có thể chọn' })
  listRenditions(@Param('assetId') assetId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.assetsService.listRenditions(assetId, context.userId, context.userType);
  }

  @Get('assets/:assetId/preview/:variantCode')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  preview(
    @Param('assetId') assetId: string,
    @Param('variantCode') variantCode: string,
    @Query('width', new ParseIntPipe({ optional: true })) width: number | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.preview(
      assetId,
      variantCode,
      context.userId,
      context.userType,
      response,
      width,
    );
  }

  @Get('assets/:assetId/preview-url')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOperation({
    summary:
      'Tạo presigned URL để tải preview trực tiếp từ R2. variantCode=preview kèm width chọn kích thước phù hợp.',
  })
  previewUrl(
    @Param('assetId') assetId: string,
    @Query('variantCode') variantCode = 'thumbnail',
    @Query('width', new ParseIntPipe({ optional: true })) width: number | undefined,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.assetsService.getPreviewUrl(
      assetId,
      variantCode,
      context.userId,
      context.userType,
      width,
    );
  }

  @Post('assets/:assetId/retry')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  retry(@Param('assetId') assetId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.assetsService.retry(assetId, context.userId, context.userType);
  }
}
