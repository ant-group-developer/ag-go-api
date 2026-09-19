import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('system')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: 'API metadata' })
  getMetadata() {
    return {
      service: 'ag-go-api',
      version: '0.1.0',
      status: 'ok',
    };
  }
}
