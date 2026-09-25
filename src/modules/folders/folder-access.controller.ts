import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { FolderAccessUsersQueryDto } from './dto/folder-access-users-query.dto';
import { FolderAccessOverviewService } from './folder-access-overview.service';
import { FoldersService } from './folders.service';

@ApiTags('folder-access')
@ApiBearerAuth()
@Controller('folder-access')
export class FolderAccessController {
  constructor(
    private readonly foldersService: FoldersService,
    private readonly overviewService: FolderAccessOverviewService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('users')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  users(@Query() query: FolderAccessUsersQueryDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.overviewService.users(query, context.userId, context.userType);
  }

  @Get('users/:userId/grants')
  @RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
  userGrants(@Param('userId') userId: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.foldersService.userGrants(userId, context.userId, context.userType);
  }
}
