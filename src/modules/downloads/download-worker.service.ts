import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { DownloadJobItemEntity } from '../../database/entities/download-job-item.entity';
import { DownloadJobEntity } from '../../database/entities/download-job.entity';
import type { DownloadQueueJobData } from '../../infra/queue/download-queue.service';
import { DOWNLOAD_JOB, DOWNLOAD_QUEUE } from '../../infra/queue/queue.constants';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';

type ZipEntry = { name: string; body: Buffer };

@Injectable()
export class DownloadWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(DownloadWorkerService.name);
  private connection?: Redis;
  private worker?: Worker<DownloadQueueJobData>;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(DownloadJobEntity)
    private readonly jobRepository: Repository<DownloadJobEntity>,
    @InjectRepository(DownloadJobItemEntity)
    private readonly itemRepository: Repository<DownloadJobItemEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepository: Repository<AssetVariantEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  start(): void {
    if (this.worker) {
      return;
    }
    this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<DownloadQueueJobData>(
      DOWNLOAD_QUEUE,
      async (job) => {
        if (job.name !== DOWNLOAD_JOB) {
          throw new Error(`Unsupported download job ${job.name}`);
        }
        await this.process(job);
      },
      {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
        concurrency: 1,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Download job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async process(job: Job<DownloadQueueJobData>): Promise<void> {
    const download = await this.jobRepository.findOne({
      where: { id: job.data.jobId, externalUserId: job.data.userId },
    });
    if (!download || ['cancelled', 'completed', 'expired'].includes(download.status)) {
      return;
    }
    await this.jobRepository.update(download.id, { status: 'processing' });
    try {
      const items = await this.itemRepository.find({
        where: { downloadJobId: download.id, status: 'queued' },
        order: { createdAt: 'ASC' },
      });
      const entries: ZipEntry[] = [];
      for (const item of items) {
        const asset = await this.assetRepository.findOne({ where: { id: item.assetId } });
        if (!asset) {
          throw new Error(`Asset ${item.assetId} not found`);
        }
        const variant =
          download.downloadType === 'rendered'
            ? await this.variantRepository.findOne({
                where: { assetId: asset.id, variantCode: 'preview', status: 'ready' },
              })
            : null;
        const key = variant?.storageKey ?? asset.originalStorageKey;
        entries.push({
          name: `${item.projectMediaId}-${asset.originalFilename}`,
          body: await streamToBuffer(this.storage.readObject(key)),
        });
        await this.itemRepository.update(item.id, { status: 'added' });
        await this.jobRepository.increment({ id: download.id }, 'completedItems', 1);
      }
      const zip = createStoredZip(entries);
      const storageKey = download.projectId
        ? `projects/${download.projectId}/downloads/${download.externalUserId}/${download.id}.zip`
        : `downloads/${download.externalUserId}/${download.id}.zip`;
      const head = await this.storage.putObject(storageKey, zip, 'application/zip');
      await this.jobRepository.update(download.id, {
        status: 'completed',
        zipBucket: this.config.getOrThrow<string>('R2_BUCKET'),
        zipStorageKey: storageKey,
        zipSizeBytes: String(head.sizeBytes),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Download worker failed';
      await this.jobRepository.update(download.id, {
        status: 'failed',
        errorMessage: message.slice(0, 4000),
      });
      throw error;
    }
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/[^\w.\-/]/g, '_'), 'utf8');
    const crc = crc32(entry.body);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.body.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, entry.body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.body.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + entry.body.length;
  }
  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
