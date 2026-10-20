import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/public.decorator';

@ApiTags('system')
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Health check' })
  getHealth() {
    return {
      status: 'ok',
      service: 'ag-go-api',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
