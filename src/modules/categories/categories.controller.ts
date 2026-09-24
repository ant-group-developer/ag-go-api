import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  list() {
    return this.categoriesService.list();
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
