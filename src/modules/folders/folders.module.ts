import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { FolderAccessService } from './folder-access.service';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';

@Module({
  imports: [TypeOrmModule.forFeature([FolderEntity, FolderClosureEntity, FolderAccessGrantEntity])],
  controllers: [FoldersController],
  providers: [AuthContextService, FolderAccessService, FoldersService],
  exports: [FolderAccessService],
})
export class FoldersModule {}
