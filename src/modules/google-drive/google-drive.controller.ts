import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Redirect,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { Public } from '../../common/auth/public.decorator';
import { CreateImportDto } from './dto/create-import.dto';
import { GoogleDriveService } from './google-drive.service';

@ApiTags('google-drive')
@ApiBearerAuth()
@Controller('google-drive')
export class GoogleDriveController {
  constructor(
    private readonly googleDrive: GoogleDriveService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('connection')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  connection(@Req() request: Request) {
    return this.googleDrive.getConnection(this.authContext.getContext(request).userId);
  }

  @Post('connection/start')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  start(@Req() request: Request, @Query('projectId') projectId?: string) {
    return this.googleDrive.startConnection(
      this.authContext.getContext(request).userId,
      projectId,
    );
  }

  @Get('connection/callback')
  @Public()
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  @Redirect()
  async callback(@Query('code') code: string, @Query('state') state: string) {
    const result = await this.googleDrive.completeConnection(code, state);
    const frontendUrl =
      process.env.GOOGLE_FRONTEND_CALLBACK_URL?.trim() ||
      'http://localhost:5173/google-drive/callback';
    const redirectUrl = new URL(frontendUrl);
    redirectUrl.searchParams.set('status', 'connected');
    if (result.projectId) {
      redirectUrl.searchParams.set('projectId', result.projectId);
    }
    return { url: redirectUrl.toString(), statusCode: 302 };
  }

  @Get('picker-token')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  pickerToken(@Req() request: Request) {
    return this.googleDrive.getPickerAccessToken(
      this.authContext.getContext(request).userId,
    );
  }

  @Delete('connection')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  disconnect(@Req() request: Request) {
    return this.googleDrive.disconnect(this.authContext.getContext(request).userId);
  }

  @Post('imports')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  createImport(@Req() request: Request, @Body() dto: CreateImportDto) {
    const context = this.authContext.getContext(request);
    return this.googleDrive.createImport(dto, context.userId, context.userType);
  }

  @Get('imports/:batchId')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  getImport(@Param('batchId') batchId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.googleDrive.getImport(batchId, context.userId, context.userType);
  }

  @Post('imports/:batchId/cancel')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  cancel(@Param('batchId') batchId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.googleDrive.cancelImport(batchId, context.userId, context.userType);
  }

  @Get('imports/:batchId/items')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  items(@Param('batchId') batchId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.googleDrive.listItems(batchId, context.userId, context.userType);
  }

  @Post('imports/:batchId/items/:itemId/retry')
  @RequirePermissions(GO_PERMISSIONS.DRIVE_IMPORT)
  retry(
    @Param('batchId') batchId: string,
    @Param('itemId') itemId: string,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.googleDrive.retryItem(batchId, itemId, context.userId, context.userType);
  }
}
