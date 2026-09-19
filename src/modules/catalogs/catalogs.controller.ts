import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { CatalogsService } from './catalogs.service';
import {
  CreateCategoryDto,
  CreateCountryDto,
  CreateProvinceDto,
  CreateTagDto,
} from './dto/create-catalog.dto';

@ApiTags('catalogs')
@Controller()
export class CatalogsController {
  constructor(
    private readonly catalogsService: CatalogsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('categories')
  categories() {
    return this.catalogsService.listCategories();
  }

  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.catalogsService.createCategory(dto);
  }

  @Get('countries')
  countries() {
    return this.catalogsService.listCountries();
  }

  @Post('countries')
  createCountry(@Body() dto: CreateCountryDto) {
    return this.catalogsService.createCountry(dto);
  }

  @Get('provinces')
  provinces(@Query('countryId') countryId?: string) {
    return this.catalogsService.listProvinces(countryId);
  }

  @Post('provinces')
  createProvince(@Body() dto: CreateProvinceDto) {
    return this.catalogsService.createProvince(dto);
  }

  @Get('tags')
  tags() {
    return this.catalogsService.listTags();
  }

  @Post('tags')
  createTag(@Body() dto: CreateTagDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.catalogsService.createTag(dto, context.userId);
  }
}
