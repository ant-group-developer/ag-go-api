import { Module } from '@nestjs/common';
import { AccountModule } from '../account/account.module';
import { CloudflareR2AnalyticsClient } from './cloudflare-r2-analytics.client';
import { R2InventoryClient } from './r2-inventory.client';
import { StorageAuditService } from './storage-audit.service';
import { StorageMonitorController } from './storage-monitor.controller';
import { StorageMonitorService } from './storage-monitor.service';

/** System > R2 storage: hourly bucket snapshots and the weekly audit (outbox worker role). */
@Module({
  imports: [AccountModule],
  controllers: [StorageMonitorController],
  providers: [
    CloudflareR2AnalyticsClient,
    R2InventoryClient,
    StorageAuditService,
    StorageMonitorService,
  ],
  exports: [StorageMonitorService],
})
export class StorageMonitorModule {}
