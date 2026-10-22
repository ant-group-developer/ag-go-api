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
import { RequireAnyPermissions } from '../../common/auth/permissions.decorator';
import type { GrantRequester } from './access-grants.service';
import { AccessGrantUsersQueryDto } from './dto/access-grant-users-query.dto';
import {
  PreviewOriginalAccessBundleDto,
  SaveOriginalAccessBundleDto,
} from './dto/save-original-access-bundle.dto';
import { OriginalAccessService } from './original-access.service';

/**
 * Bundles of originals (folders × categories). Anyone who may open the Permissions menu grants
 * them within their own reach; admins grant anything.
 */
@ApiTags('original-access')
@ApiBearerAuth()
@Controller('original-access')
@RequireAnyPermissions(GO_PERMISSIONS.FOLDER_MANAGE, GO_PERMISSIONS.CATEGORY_ACCESS_MANAGE)
export class OriginalAccessController {
  constructor(
    private readonly originalAccess: OriginalAccessService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('users')
  @ApiOperation({ summary: 'Users with bundles (admins: every one; others: those they granted)' })
  users(@Query() query: AccessGrantUsersQueryDto, @Req() request: Request) {
    return this.originalAccess.users(query, this.requester(request));
  }

  @Get('users/:userId')
  @ApiOperation({ summary: "Every bundle of one user; `canEdit` says which are the requester's" })
  userBundles(@Param('userId') userId: string, @Req() request: Request) {
    return this.originalAccess.userBundles(userId, this.requester(request));
  }

  @Get('categories/:categoryId')
  @ApiOperation({ summary: 'Bundles holding one category' })
  categoryBundles(@Param('categoryId', ParseUUIDPipe) categoryId: string, @Req() request: Request) {
    return this.originalAccess.categoryBundles(categoryId, this.requester(request));
  }

  @Get('reach')
  @ApiOperation({
    summary: 'Thư mục và danh mục người gọi được đưa vào gói (null: không giới hạn, Admin)',
  })
  reach(@Req() request: Request) {
    return this.originalAccess.reach(this.requester(request));
  }

  @Post('preview')
  @ApiOperation({ summary: 'Các cặp thư mục × danh mục nằm ngoài phần của người gọi' })
  preview(@Body() dto: PreviewOriginalAccessBundleDto, @Req() request: Request) {
    return this.originalAccess.preview(dto, this.requester(request));
  }

  @Post('bundles')
  @ApiOperation({ summary: 'Cấp một gói bản gốc: các thư mục × các danh mục' })
  create(@Body() dto: SaveOriginalAccessBundleDto, @Req() request: Request) {
    return this.originalAccess.create(dto, this.requester(request));
  }

  @Patch('bundles/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveOriginalAccessBundleDto,
    @Req() request: Request,
  ) {
    return this.originalAccess.update(id, dto, this.requester(request));
  }

  @Delete('bundles/:id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    await this.originalAccess.remove(id, this.requester(request));
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
