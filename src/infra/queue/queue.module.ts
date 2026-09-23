import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxService } from '../../common/outbox.service';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { DownloadQueueService } from './download-queue.service';
import { ImportQueueService } from './import-queue.service';
import { MediaQueueService } from './media-queue.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEventEntity])],
  providers: [
    MediaQueueService,
    DownloadQueueService,
    ImportQueueService,
    OutboxDispatcherService,
    OutboxService,
  ],
  exports: [
    MediaQueueService,
    DownloadQueueService,
    ImportQueueService,
    OutboxDispatcherService,
    OutboxService,
  ],
})
export class QueueModule {}
