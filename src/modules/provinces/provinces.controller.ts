import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CreateProvinceDto } from './dto/create-province.dto';
import { ListProvincesQueryDto } from './dto/list-provinces-query.dto';
import { ProvincesService } from './provinces.service';

@ApiTags('provinces')
@ApiBearerAuth()
@Controller('provinces')
export class ProvincesController {
  constructor(private readonly provincesService: ProvincesService) {}

  @Get()
  @ApiQuery({ name: 'countryId', required: false, type: String })
  @ApiQuery({ name: 'keyword', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String, deprecated: true })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 20 })
  list(@Query() query: ListProvincesQueryDto) {
    return this.provincesService.list(query);
  }

  @Post()
  create(@Body() dto: CreateProvinceDto) {
    return this.provincesService.create(dto);
  }
}
