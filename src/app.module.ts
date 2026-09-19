import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { CategoryEntity } from './database/entities/category.entity';
import { CountryEntity } from './database/entities/country.entity';
import { FolderAccessGrantEntity } from './database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from './database/entities/folder-closure.entity';
import { FolderEntity } from './database/entities/folder.entity';
import { ProjectEntity } from './database/entities/project.entity';
import { ProvinceEntity } from './database/entities/province.entity';
import { TagEntity } from './database/entities/tag.entity';
import { HealthController } from './health/health.controller';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
import { FoldersModule } from './modules/folders/folders.module';
import { ProjectsModule } from './modules/projects/projects.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL', 'postgres://aggo:aggo@localhost:55432/aggo'),
        entities: [
          FolderEntity,
          FolderClosureEntity,
          FolderAccessGrantEntity,
          CategoryEntity,
          CountryEntity,
          ProvinceEntity,
          TagEntity,
          ProjectEntity,
        ],
        synchronize: false,
        migrationsRun: false,
      }),
    }),
    FoldersModule,
    CatalogsModule,
    ProjectsModule,
  ],
  controllers: [AppController, HealthController],
})
export class AppModule {}
