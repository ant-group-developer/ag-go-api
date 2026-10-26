import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { AccessGrantsService, type GrantRequester } from './access-grants.service';
import { AccessGrantUsersQueryDto } from './dto/access-grant-users-query.dto';
import { CreateAccessGrantsDto } from './dto/create-access-grants.dto';
import { UpdateAccessGrantDto } from './dto/update-access-grant.dto';

/**
 * Work grants on folders, for their managers. Each route only shows and changes the grants the
 * requester manages.
 */
@ApiTags('access-grants')
@ApiBearerAuth()
@Controller('access-grants')
@RequirePermissions(GO_PERMISSIONS.FOLDER_MANAGE)
export class AccessGrantsController {
  constructor(
    private readonly grantsService: AccessGrantsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('users')
  @ApiOperation({ summary: 'Users with grants the requester manages' })
  users(@Query() query: AccessGrantUsersQueryDto, @Req() request: Request) {
    return this.grantsService.users(query, this.requester(request));
  }

  @Get('users/:userId')
  @ApiOperation({ summary: 'Grants of one user that the requester manages' })
  userGrants(@Param('userId') userId: string, @Req() request: Request) {
    return this.grantsService.userGrants(userId, this.requester(request));
  }

  @Get('folders/:folderId')
  @ApiOperation({ summary: 'Grants on a folder and those it inherits (folder managers)' })
  folderGrants(@Param('folderId', ParseUUIDPipe) folderId: string, @Req() request: Request) {
    return this.grantsService.folderGrants(folderId, this.requester(request));
  }

  @Get('categories/:categoryId')
  @ApiOperation({ summary: 'Grants limited to one category that the requester manages' })
  categoryGrants(@Param('categoryId', ParseUUIDPipe) categoryId: string, @Req() request: Request) {
    return this.grantsService.categoryGrants(categoryId, this.requester(request));
  }

  @Post()
  @ApiOperation({
    summary: 'Cấp quyền làm việc cho một user trên thư mục × từng danh mục (hoặc mọi danh mục)',
  })
  create(@Body() dto: CreateAccessGrantsDto, @Req() request: Request) {
    return this.grantsService.create(dto, this.requester(request));
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccessGrantDto,
    @Req() request: Request,
  ) {
    return this.grantsService.update(id, dto, this.requester(request));
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    await this.grantsService.remove(id, this.requester(request));
    return { success: true };
  }

  private requester(request: Request): GrantRequester {
    const context = this.authContext.getContext(request);
    return {
      userId: context.userId,
      userType: context.userType,
      permissions: context.permissions,
    };
  }
}
