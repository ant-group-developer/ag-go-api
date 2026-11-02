import { Module } from '@nestjs/common';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { AcceptancesModule } from '../acceptances/acceptances.module';
import { AccountModule } from '../account/account.module';
import { StorageModule } from '../assets/storage/storage.module';
import { ContractsModule } from '../contracts/contracts.module';
import { LogsModule } from '../logs/logs.module';
import { PaymentReportsController } from './payment-reports.controller';
import { PaymentReportsService } from './payment-reports.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/** Payments, contract ledger and reports (spec 6.6, 6.7, 7.8). */
@Module({
  imports: [AccountModule, AcceptancesModule, ContractsModule, LogsModule, StorageModule],
  controllers: [PaymentsController, PaymentReportsController],
  providers: [
    AuthContextService,
    ActorEnrichmentService,
    PiiCipherService,
    PaymentsService,
    PaymentReportsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
