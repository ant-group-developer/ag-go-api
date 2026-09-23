import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions, RequirePermissions } from '../../common/auth/permissions.decorator';
import { DownloadsService } from './downloads.service';
import { CreateDownloadDto } from './dto/create-download.dto';

@ApiTags('downloads')
@ApiBearerAuth()
@Controller('downloads')
export class DownloadsController {
  constructor(
    private readonly downloadsService: DownloadsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Post()
  @RequireAnyPermissions(
    GO_PERMISSIONS.PROJECT_DOWNLOAD_ORIGINAL,
    GO_PERMISSIONS.PROJECT_DOWNLOAD_RENDERED,
  )
  create(
    @Body() dto: CreateDownloadDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.downloadsService.create(
      dto,
      context.userId,
      context.permissions ?? [],
      context.userType,
      idempotencyKey,
      {
        ipAddress: request.ip,
        userAgent: request.header('user-agent'),
      },
    );
  }

  @Get(':id')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  get(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.downloadsService.get(id, context.userId, context.userType);
  }

  @Post(':id/cancel')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  cancel(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.downloadsService.cancel(id, context.userId, context.userType);
  }
}
