import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { OutboxDispatcherService } from '../infra/queue/outbox-dispatcher.service';
import { MediaQueueWorkerService } from '../modules/assets/media-queue-worker.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  const config = app.get(ConfigService);
  const role = process.argv[2] ?? 'all';
  if ((role === 'all' || role === 'media') && config.getOrThrow<boolean>('MEDIA_WORKER_ENABLED')) {
    app.get(MediaQueueWorkerService).start();
  }
  if (role === 'all' || role === 'outbox') {
    app.get(OutboxDispatcherService).start();
  }

  const shutdown = async () => {
    await app.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void bootstrap();
