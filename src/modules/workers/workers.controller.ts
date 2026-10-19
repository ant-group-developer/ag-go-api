import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly } from '../../common/auth/permissions.decorator';
import { WorkersService } from './workers.service';

@ApiTags('system')
@ApiBearerAuth()
@Controller('system/workers')
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Get()
  @AdminOnly()
  @ApiOperation({
    summary: 'Worker processes on every host, with the commit they run (admins only)',
  })
  list() {
    return this.workers.list();
  }
}
