import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { OutboxDispatcherService } from '../infra/queue/outbox-dispatcher.service';
import { MediaQueueWorkerService } from '../modules/assets/media-queue-worker.service';
import { DownloadWorkerService } from '../modules/downloads/download-worker.service';
import { GoogleDriveImportWorkerService } from '../modules/google-drive/google-drive-import-worker.service';

const WORKER_ROLES = ['media', 'download', 'import', 'outbox'] as const;
type WorkerRole = (typeof WORKER_ROLES)[number];

// Accepts `all` (the default) or a comma-separated list such as `import,outbox`, so one
// process can host several light roles while heavy ones get a container of their own.
function parseRoles(arg: string | undefined): Set<WorkerRole> {
  if (!arg || arg === 'all') {
    return new Set(WORKER_ROLES);
  }
  const roles = arg
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  const unknown = roles.filter((role) => !(WORKER_ROLES as readonly string[]).includes(role));
  if (roles.length === 0 || unknown.length > 0) {
    throw new Error(
      `Invalid worker role "${arg}". Use "all" or a comma-separated list of: ${WORKER_ROLES.join(', ')}`,
    );
  }
  return new Set(roles as WorkerRole[]);
}

async function bootstrap(): Promise<void> {
  const roles = parseRoles(process.argv[2]);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  const config = app.get(ConfigService);
  if (roles.has('media') && config.getOrThrow<boolean>('MEDIA_WORKER_ENABLED')) {
    app.get(MediaQueueWorkerService).start();
  }
  if (roles.has('download')) {
    app.get(DownloadWorkerService).start();
  }
  if (roles.has('import')) {
    app.get(GoogleDriveImportWorkerService).start();
  }
  if (roles.has('outbox')) {
    app.get(OutboxDispatcherService).start();
  }

  const shutdown = async () => {
    await app.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void bootstrap();
