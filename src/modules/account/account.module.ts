import { Module } from '@nestjs/common';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { AccountApiService } from './account-api.service';
import { AccountController } from './account.controller';

@Module({
  controllers: [AccountController],
  providers: [AuthContextService, AccountApiService, ActorEnrichmentService],
  exports: [AuthContextService, AccountApiService, ActorEnrichmentService],
})
export class AccountModule {}
