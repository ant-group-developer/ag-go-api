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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { MAX_CSV_FILE_SIZE_BYTES, type CsvUploadFile } from '../../common/csv/csv-import';
import { CreateProvinceDto } from './dto/create-province.dto';
import { ListProvincesQueryDto } from './dto/list-provinces-query.dto';
import { ProvinceListResponseDto } from './dto/province-list-response.dto';
import { ProvincesService } from './provinces.service';

@ApiTags('provinces')
@ApiBearerAuth()
@Controller('provinces')
export class ProvincesController {
  constructor(private readonly provincesService: ProvincesService) {}

  @Get()
  @ApiOkResponse({ type: ProvinceListResponseDto })
  list(@Query() query: ListProvincesQueryDto) {
    return this.provincesService.list(query);
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
    return this.provincesService.importCsv(file);
  }

  @Post()
  @RequirePermissions(GO_PERMISSIONS.CATALOG_MANAGE)
  create(@Body() dto: CreateProvinceDto) {
    return this.provincesService.create(dto);
  }
}
