import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetImportEntity } from '../../database/entities/asset-import.entity';
import { GoogleDriveConnectionEntity } from '../../database/entities/google-drive-connection.entity';
import { ImportBatchEntity } from '../../database/entities/import-batch.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { QueueModule } from '../../infra/queue/queue.module';
import { AccountModule } from '../account/account.module';
import { StorageModule } from '../assets/storage/storage.module';
import { FoldersModule } from '../folders/folders.module';
import { GoogleDriveImportWorkerService } from './google-drive-import-worker.service';
import { GoogleDriveController } from './google-drive.controller';
import { GoogleDriveService } from './google-drive.service';

@Module({
  imports: [
    AccountModule,
    FoldersModule,
    QueueModule,
    StorageModule,
    TypeOrmModule.forFeature([
      GoogleDriveConnectionEntity,
      ImportBatchEntity,
      AssetImportEntity,
      ProjectEntity,
    ]),
  ],
  controllers: [GoogleDriveController],
  providers: [AuthContextService, GoogleDriveService, GoogleDriveImportWorkerService],
})
export class GoogleDriveModule {}
