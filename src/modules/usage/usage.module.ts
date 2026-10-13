import { Module } from '@nestjs/common';
import { StudioUsageController } from './studio-usage.controller';
import { StudioUsageService } from './studio-usage.service';

/** How AG Studio uses ag-go footage: events in, usage counts out. */
@Module({
  controllers: [StudioUsageController],
  providers: [StudioUsageService],
  exports: [StudioUsageService],
})
export class UsageModule {}
