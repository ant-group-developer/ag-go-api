import { Module } from '@nestjs/common';
import { AuthContextService } from '../../common/auth-context.service';
import { LogsModule } from '../logs/logs.module';
import { RateCardsController } from './rate-cards.controller';
import { RateCardsService } from './rate-cards.service';

@Module({
  imports: [LogsModule],
  controllers: [RateCardsController],
  providers: [AuthContextService, RateCardsService],
  exports: [RateCardsService],
})
export class RateCardsModule {}
