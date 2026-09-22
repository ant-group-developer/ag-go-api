import { Module } from '@nestjs/common';
import { AuthContextService } from '../../common/auth-context.service';
import { AccountApiService } from './account-api.service';
import { AccountController } from './account.controller';

@Module({
  controllers: [AccountController],
  providers: [AuthContextService, AccountApiService],
  exports: [AccountApiService],
})
export class AccountModule {}
