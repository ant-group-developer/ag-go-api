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
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
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
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  /** Each category with its creator as `createdByUser` (null when unknown). */
  @Get()
  async list(@Query() query: ListCategoriesQueryDto, @Req() request: Request) {
    let grantedToUserId: string | undefined;
    if (query.granted) {
      const context = this.authContext.getContext(request);
      grantedToUserId = isAdminUserType(context.userType) ? undefined : context.userId;
    }
    const categories = await this.categoriesService.list(grantedToUserId);
    return this.actorEnrichment.enrich(categories as unknown as Array<Record<string, unknown>>, [
      { id: 'createdBy', target: 'createdByUser' },
    ]);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.CATEGORY_CREATE)
  create(@Body() dto: CreateCategoryDto, @Req() request: Request) {
    return this.categoriesService.create(dto, this.authContext.getContext(request).userId);
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
