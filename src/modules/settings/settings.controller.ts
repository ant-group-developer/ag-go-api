import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { Public } from '../../common/auth/public.decorator';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { WebSettingsDto } from './dto/web-settings-response.dto';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('public')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOkResponse({ type: WebSettingsDto })
  getPublic() {
    return this.settings.getPublic();
  }

  @Get()
  @ApiBearerAuth()
  @RequirePermissions(GO_PERMISSIONS.SETTINGS_MANAGE)
  @ApiOkResponse({ type: WebSettingsDto })
  get() {
    return this.settings.get();
  }

  @Patch()
  @ApiBearerAuth()
  @RequirePermissions(GO_PERMISSIONS.SETTINGS_MANAGE)
  @ApiOkResponse({ type: WebSettingsDto })
  update(@Body() dto: UpdateSettingsDto, @Req() request: Request) {
    return this.settings.update(dto, this.authContext.getContext(request).userId);
  }
}
