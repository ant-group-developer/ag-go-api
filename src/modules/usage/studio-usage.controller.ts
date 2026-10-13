import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ServiceOnly } from '../../common/auth/service-only.decorator';
import { StudioUsageEventsDto } from './dto/studio-events.dto';
import { StudioUsageService } from './studio-usage.service';

@ApiTags('usage')
@Controller()
export class StudioUsageController {
  constructor(private readonly usage: StudioUsageService) {}

  @Post('usage/studio-events')
  @HttpCode(200)
  @ServiceOnly('usage:write')
  @ApiSecurity('service-key')
  @ApiOperation({ summary: 'Footage usage events from AG Studio (service key only)' })
  record(@Body() dto: StudioUsageEventsDto) {
    return this.usage.record(dto.events);
  }
}
