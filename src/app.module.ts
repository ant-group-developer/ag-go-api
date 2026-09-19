import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { Auth0Guard } from './common/auth/auth0.guard';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { RequestLoggingInterceptor } from './common/request-logging.interceptor';
import { AssetUploadSessionEntity } from './database/entities/asset-upload-session.entity';
import { AssetVariantEntity } from './database/entities/asset-variant.entity';
import { AssetEntity } from './database/entities/asset.entity';
import { CategoryEntity } from './database/entities/category.entity';
import { CountryEntity } from './database/entities/country.entity';
import { FolderAccessGrantEntity } from './database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from './database/entities/folder-closure.entity';
import { FolderEntity } from './database/entities/folder.entity';
import { MediaRenderJobEntity } from './database/entities/media-render-job.entity';
import { ProjectEvaluationSummaryEntity } from './database/entities/project-evaluation-summary.entity';
import { ProjectMediaEntity } from './database/entities/project-media.entity';
import { ProjectEntity } from './database/entities/project.entity';
import { ProvinceEntity } from './database/entities/province.entity';
import { TagEntity } from './database/entities/tag.entity';
import { HealthController } from './health/health.controller';
import { AssetsModule } from './modules/assets/assets.module';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
import { FoldersModule } from './modules/folders/folders.module';
import { MediaModule } from './modules/media/media.module';
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
          AssetEntity,
          ProjectMediaEntity,
          ProjectEvaluationSummaryEntity,
          AssetUploadSessionEntity,
          AssetVariantEntity,
          MediaRenderJobEntity,
        ],
        synchronize: false,
        migrationsRun: false,
      }),
    }),
    FoldersModule,
    CatalogsModule,
    ProjectsModule,
    MediaModule,
    AssetsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: Auth0Guard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
