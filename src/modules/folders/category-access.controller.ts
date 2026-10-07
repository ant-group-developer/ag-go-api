import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { CategoryAccessService } from './category-access.service';
import { AddCategoryGrantsDto } from './dto/add-category-grants.dto';
import { CategoryAccessUsersQueryDto } from './dto/category-access-users-query.dto';

@ApiTags('category-access')
@ApiBearerAuth()
@Controller('category-access')
export class CategoryAccessController {
  constructor(
    private readonly categoryAccessService: CategoryAccessService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('users')
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_ACCESS_MANAGE)
  @ApiOperation({ summary: 'Users with category grants (they decide the "Projects" page)' })
  users(@Query() query: CategoryAccessUsersQueryDto) {
    return this.categoryAccessService.users(query);
  }

  @Get('categories/:categoryId/grants')
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_ACCESS_MANAGE)
  @ApiOperation({ summary: 'Users granted one category' })
  categoryGrants(@Param('categoryId', ParseUUIDPipe) categoryId: string) {
    return this.categoryAccessService.categoryGrants(categoryId);
  }

  @Get('users/:userId/grants')
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_ACCESS_MANAGE)
  userGrants(@Param('userId') userId: string) {
    return this.categoryAccessService.userGrants(userId);
  }

  @Post('users/:userId/grants')
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_ACCESS_MANAGE)
  addGrants(
    @Param('userId') userId: string,
    @Body() dto: AddCategoryGrantsDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.categoryAccessService.addGrants(userId, dto.categoryIds, context.userId);
  }

  @Delete('users/:userId/grants/:categoryId')
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_ACCESS_MANAGE)
  async removeGrant(
    @Param('userId') userId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
  ) {
    await this.categoryAccessService.removeGrant(userId, categoryId);
    return { success: true };
  }
}
