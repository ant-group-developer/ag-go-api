import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { ProjectAuditLogEntity } from '../../database/entities/project-audit-log.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { AccountModule } from '../account/account.module';
import { FoldersModule } from '../folders/folders.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  imports: [
    AccountModule,
    FoldersModule,
    TypeOrmModule.forFeature([ProjectAuditLogEntity, ProjectEntity]),
  ],
  controllers: [AuditController],
  providers: [AuthContextService, ActorEnrichmentService, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
