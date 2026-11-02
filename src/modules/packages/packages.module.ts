import { Module } from '@nestjs/common';
import { AuthContextService } from '../../common/auth-context.service';
import { LogsModule } from '../logs/logs.module';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';

@Module({
  imports: [LogsModule],
  controllers: [PackagesController],
  providers: [AuthContextService, PackagesService],
  exports: [PackagesService],
})
export class PackagesModule {}
