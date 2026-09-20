import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxService } from '../../common/outbox.service';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { MediaQueueService } from './media-queue.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEventEntity])],
  providers: [MediaQueueService, OutboxDispatcherService, OutboxService],
  exports: [MediaQueueService, OutboxDispatcherService, OutboxService],
})
export class QueueModule {}
