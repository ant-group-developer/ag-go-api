import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';

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
  @RequirePermissions(GO_PERMISSIONS.CATALOG_MANAGE)
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }
}
