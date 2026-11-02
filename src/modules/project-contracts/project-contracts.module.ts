import { forwardRef, Module } from '@nestjs/common';
import { AuthContextService } from '../../common/auth-context.service';
import { AccountModule } from '../account/account.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { AuditModule } from '../audit/audit.module';
import { ContractsModule } from '../contracts/contracts.module';
import { FoldersModule } from '../folders/folders.module';
import { PartnersModule } from '../partners/partners.module';
import { ProjectContractsOutboxService } from './project-contracts-outbox.service';
import { ProjectContractsController } from './project-contracts.controller';
import { ProjectContractsService } from './project-contracts.service';
import { SpecChecksService } from './spec-checks.service';

@Module({
  imports: [
    AccountModule,
    AuditModule,
    ContractsModule,
    FoldersModule,
    PartnersModule,
    forwardRef(() => AnalysisModule),
  ],
  controllers: [ProjectContractsController],
  providers: [
    AuthContextService,
    SpecChecksService,
    ProjectContractsOutboxService,
    ProjectContractsService,
  ],
  exports: [SpecChecksService, ProjectContractsOutboxService],
})
export class ProjectContractsModule {}
