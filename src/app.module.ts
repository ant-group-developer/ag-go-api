import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { Auth0Guard } from './common/auth/auth0.guard';
import { PermissionsGuard } from './common/auth/permissions.guard';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { RequestLoggingInterceptor } from './common/request-logging.interceptor';
import { envValidationSchema } from './config/env.validation';
import { AssetImportEntity } from './database/entities/asset-import.entity';
import { AssetUploadSessionEntity } from './database/entities/asset-upload-session.entity';
import { AssetVariantEntity } from './database/entities/asset-variant.entity';
import { AssetEntity } from './database/entities/asset.entity';
import { CategoryEntity } from './database/entities/category.entity';
import { CountryEntity } from './database/entities/country.entity';
import { DownloadJobItemEntity } from './database/entities/download-job-item.entity';
import { DownloadJobEntity } from './database/entities/download-job.entity';
import { DownloadLogEntity } from './database/entities/download-log.entity';
import { FolderAccessGrantEntity } from './database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from './database/entities/folder-closure.entity';
import { FolderEntity } from './database/entities/folder.entity';
import { GoogleDriveConnectionEntity } from './database/entities/google-drive-connection.entity';
import { ImportBatchEntity } from './database/entities/import-batch.entity';
import { MediaRenderJobEntity } from './database/entities/media-render-job.entity';
import { OutboxEventEntity } from './database/entities/outbox-event.entity';
import { ProjectAuditLogEntity } from './database/entities/project-audit-log.entity';
import { ProjectEvaluationSummaryEntity } from './database/entities/project-evaluation-summary.entity';
import { ProjectMediaEvaluationEntity } from './database/entities/project-media-evaluation.entity';
import { ProjectMediaEntity } from './database/entities/project-media.entity';
import { ProjectEntity } from './database/entities/project.entity';
import { ProvinceEntity } from './database/entities/province.entity';
import { RenderBatchEntity } from './database/entities/render-batch.entity';
import { RenderProfileEntity } from './database/entities/render-profile.entity';
import { TagEntity } from './database/entities/tag.entity';
import { SystemLogEntity } from './database/entities/system-log.entity';
import { SystemSettingEntity } from './database/entities/system-setting.entity';
import { HealthController } from './health/health.controller';
import { QueueModule } from './infra/queue/queue.module';
import { AccountModule } from './modules/account/account.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AuditModule } from './modules/audit/audit.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CountriesModule } from './modules/countries/countries.module';
import { DownloadsModule } from './modules/downloads/downloads.module';
import { FoldersModule } from './modules/folders/folders.module';
import { GoogleDriveModule } from './modules/google-drive/google-drive.module';
import { MediaModule } from './modules/media/media.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ProvincesModule } from './modules/provinces/provinces.module';
import { RenderModule } from './modules/render/render.module';
import { StatisticsModule } from './modules/statistics/statistics.module';
import { TagsModule } from './modules/tags/tags.module';
import { SettingsModule } from './modules/settings/settings.module';
import { LogsModule } from './modules/logs/logs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        schema: config.getOrThrow<string>('DATABASE_SCHEMA'),
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
          ProjectMediaEvaluationEntity,
          ProjectEvaluationSummaryEntity,
          AssetUploadSessionEntity,
          AssetVariantEntity,
          MediaRenderJobEntity,
          RenderProfileEntity,
          RenderBatchEntity,
          GoogleDriveConnectionEntity,
          ImportBatchEntity,
          AssetImportEntity,
          DownloadJobEntity,
          DownloadJobItemEntity,
          DownloadLogEntity,
          ProjectAuditLogEntity,
          SystemSettingEntity,
          SystemLogEntity,
          OutboxEventEntity,
        ],
        synchronize: false,
        migrationsRun: false,
      }),
    }),
    FoldersModule,
    CategoriesModule,
    CountriesModule,
    ProvincesModule,
    TagsModule,
    ProjectsModule,
    MediaModule,
    AssetsModule,
    QueueModule,
    AccountModule,
    RenderModule,
    DownloadsModule,
    AuditModule,
    StatisticsModule,
    GoogleDriveModule,
    SettingsModule,
    LogsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: Auth0Guard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ApiResponseInterceptor,
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
