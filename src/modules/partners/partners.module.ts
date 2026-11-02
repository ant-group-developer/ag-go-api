import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { AuthContextService } from '../../common/auth-context.service';
import { PartnerEntity } from '../../database/entities/partner.entity';
import { AccountModule } from '../account/account.module';
import { LogsModule } from '../logs/logs.module';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';

@Module({
  imports: [AccountModule, LogsModule, TypeOrmModule.forFeature([PartnerEntity])],
  controllers: [PartnersController],
  providers: [AuthContextService, ActorEnrichmentService, PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
