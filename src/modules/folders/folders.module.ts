import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AccessGrantEntity } from '../../database/entities/access-grant.entity';
import { CategoryEntity } from '../../database/entities/category.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { OriginalAccessBundleEntity } from '../../database/entities/original-access-bundle.entity';
import { AccountModule } from '../account/account.module';
import { AccessGrantsController } from './access-grants.controller';
import { AccessGrantsService } from './access-grants.service';
import { FolderAccessService } from './folder-access.service';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { OriginalAccessController } from './original-access.controller';
import { OriginalAccessService } from './original-access.service';

@Module({
  imports: [
    AccountModule,
    TypeOrmModule.forFeature([
      FolderEntity,
      FolderClosureEntity,
      AccessGrantEntity,
      CategoryEntity,
      OriginalAccessBundleEntity,
    ]),
  ],
  controllers: [FoldersController, AccessGrantsController, OriginalAccessController],
  providers: [
    AuthContextService,
    FolderAccessService,
    FoldersService,
    AccessGrantsService,
    OriginalAccessService,
  ],
  exports: [FolderAccessService, OriginalAccessService],
})
export class FoldersModule {}
