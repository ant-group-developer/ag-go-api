import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { DocumentTemplateEntity } from '../../database/entities/document-template.entity';
import { GeneratedDocumentEntity } from '../../database/entities/generated-document.entity';
import { SystemSettingEntity } from '../../database/entities/system-setting.entity';
import { DocumentQueueService } from '../../infra/queue/document-queue.service';
import { AccountModule } from '../account/account.module';
import { StorageModule } from '../assets/storage/storage.module';
import { LogsModule } from '../logs/logs.module';
import { CompanySettingsService } from './company-settings.service';
import {
  CompanySettingsController,
  DocumentTemplatesController,
} from './document-templates.controller';
import { DocumentTemplatesService } from './document-templates.service';
import { DocumentWorkerService } from './document-worker.service';
import { DocumentsService } from './documents.service';
import { GotenbergClient } from './gotenberg.client';

/**
 * Contract documents core (spec 6.5, 7.9, 13): templates, party A settings, rendering and the
 * worker-io `documents` queue. It does not depend on the contracts / acceptances modules, which
 * call it when issuing; their document endpoints live in ContractDocumentsModule.
 */
@Module({
  imports: [
    AccountModule,
    LogsModule,
    StorageModule,
    TypeOrmModule.forFeature([
      DocumentTemplateEntity,
      GeneratedDocumentEntity,
      SystemSettingEntity,
    ]),
  ],
  controllers: [DocumentTemplatesController, CompanySettingsController],
  providers: [
    AuthContextService,
    PiiCipherService,
    GotenbergClient,
    DocumentQueueService,
    CompanySettingsService,
    DocumentTemplatesService,
    DocumentsService,
    DocumentWorkerService,
  ],
  exports: [
    CompanySettingsService,
    DocumentTemplatesService,
    DocumentsService,
    DocumentWorkerService,
  ],
})
export class DocumentsModule {}
