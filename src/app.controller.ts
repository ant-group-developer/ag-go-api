import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './common/auth/public.decorator';

@ApiTags('system')
@Controller()
@Public()
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
