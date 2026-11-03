import { Module } from '@nestjs/common';
import { AuthContextService } from '../../common/auth-context.service';
import { AcceptancesModule } from '../acceptances/acceptances.module';
import { AccountModule } from '../account/account.module';
import { ContractsModule } from '../contracts/contracts.module';
import { DocumentsModule } from '../documents/documents.module';
import { PartnersModule } from '../partners/partners.module';
import { ContractDocumentsController } from './contract-documents.controller';
import { ContractDocumentsService } from './contract-documents.service';

/** Document endpoints of contracts, amendments and acceptance records (spec 10 `contract-documents`). */
@Module({
  imports: [AccountModule, AcceptancesModule, ContractsModule, DocumentsModule, PartnersModule],
  controllers: [ContractDocumentsController],
  providers: [AuthContextService, ContractDocumentsService],
})
export class ContractDocumentsModule {}
