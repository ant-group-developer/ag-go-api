import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { CreateRenderBatchDto } from './dto/create-render-batch.dto';
import { UpdateRenderProfileDto } from './dto/update-render-profile.dto';
import { RenderService } from './render.service';

@ApiTags('render')
@ApiBearerAuth()
@Controller()
export class RenderController {
  constructor(
    private readonly renderService: RenderService,
    private readonly authContext: AuthContextService,
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

  @Post('render-batches')
  @RequirePermissions(GO_PERMISSIONS.RENDER_BATCH)
  createBatch(@Body() dto: CreateRenderBatchDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.renderService.createBatch(dto, context.userId, context.userType);
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
