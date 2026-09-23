import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { MAX_CSV_FILE_SIZE_BYTES, type CsvUploadFile } from '../../common/csv/csv-import';
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

  @Post('import')
  @RequirePermissions(GO_PERMISSIONS.CATALOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_CSV_FILE_SIZE_BYTES, files: 1 },
    }),
  )
  importCsv(@UploadedFile() file?: CsvUploadFile) {
    return this.countriesService.importCsv(file);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.CATALOG_MANAGE)
  create(@Body() dto: CreateCountryDto) {
    return this.countriesService.create(dto);
  }
}
