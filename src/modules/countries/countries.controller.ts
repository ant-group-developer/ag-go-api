import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CountriesService } from './countries.service';
import { CreateCountryDto } from './dto/create-country.dto';

@ApiTags('countries')
@ApiBearerAuth()
@Controller('countries')
export class CountriesController {
  constructor(private readonly countriesService: CountriesService) {}

  @Get()
  list() {
    return this.countriesService.list();
  }

  @Post()
  create(@Body() dto: CreateCountryDto) {
    return this.countriesService.create(dto);
  }
}
