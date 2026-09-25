import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { AccountModule } from '../account/account.module';
import { FolderAccessOverviewService } from './folder-access-overview.service';
import { FolderAccessController } from './folder-access.controller';
import { FolderAccessService } from './folder-access.service';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';

@Module({
  imports: [
    AccountModule,
    TypeOrmModule.forFeature([FolderEntity, FolderClosureEntity, FolderAccessGrantEntity]),
  ],
  controllers: [FoldersController, FolderAccessController],
  providers: [AuthContextService, FolderAccessService, FolderAccessOverviewService, FoldersService],
  exports: [FolderAccessService],
})
export class FoldersModule {}
