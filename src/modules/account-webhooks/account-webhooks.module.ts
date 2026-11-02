import { Module } from '@nestjs/common';
import { AccountModule } from '../account/account.module';
import { PartnersModule } from '../partners/partners.module';
import { AccountWebhooksController } from './account-webhooks.controller';
import { AccountWebhooksService } from './account-webhooks.service';

@Module({
  imports: [AccountModule, PartnersModule],
  controllers: [AccountWebhooksController],
  providers: [AccountWebhooksService],
})
export class AccountWebhooksModule {}
