import { Module } from '@nestjs/common';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { AccountModule } from '../account/account.module';
import { ContractsModule } from '../contracts/contracts.module';
import { DocumentsModule } from '../documents/documents.module';
import { LogsModule } from '../logs/logs.module';
import { PartnersModule } from '../partners/partners.module';
import { AcceptancesController } from './acceptances.controller';
import { AcceptancesService } from './acceptances.service';

@Module({
  imports: [AccountModule, ContractsModule, DocumentsModule, LogsModule, PartnersModule],
  controllers: [AcceptancesController],
  providers: [AuthContextService, ActorEnrichmentService, PiiCipherService, AcceptancesService],
  exports: [AcceptancesService],
})
export class AcceptancesModule {}
