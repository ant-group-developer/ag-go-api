import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MAX_CSV_FILE_SIZE_BYTES, type CsvUploadFile } from '../../common/csv/csv-import';
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

  @Post('import')
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
    return this.provincesService.importCsv(file);
  }

  @Post()
  create(@Body() dto: CreateProvinceDto) {
    return this.provincesService.create(dto);
  }
}
