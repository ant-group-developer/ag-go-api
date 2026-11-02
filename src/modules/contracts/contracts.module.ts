import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { ContractAmendmentEntity } from '../../database/entities/contract-amendment.entity';
import { ContractEntity } from '../../database/entities/contract.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import { AccountModule } from '../account/account.module';
import { DocumentsModule } from '../documents/documents.module';
import { LogsModule } from '../logs/logs.module';
import { PartnersModule } from '../partners/partners.module';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

@Module({
  imports: [
    AccountModule,
    DocumentsModule,
    LogsModule,
    PartnersModule,
    TypeOrmModule.forFeature([ContractEntity, ContractAmendmentEntity, PartnerEntity]),
  ],
  controllers: [ContractsController],
  providers: [AuthContextService, ActorEnrichmentService, PiiCipherService, ContractsService],
  exports: [ContractsService],
})
export class ContractsModule {}
