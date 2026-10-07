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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { isAdminUserType } from '../../common/auth/user-type';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  list(@Query() query: ListCategoriesQueryDto, @Req() request: Request) {
    if (!query.granted) {
      return this.categoriesService.list();
    }
    const context = this.authContext.getContext(request);
    return this.categoriesService.list(
      isAdminUserType(context.userType) ? undefined : context.userId,
    );
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_CREATE)
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_EDIT)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.categoriesService.remove(id);
    return { success: true };
  }
}
