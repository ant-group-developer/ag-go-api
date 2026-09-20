import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { Auth0Guard } from './common/auth/auth0.guard';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { RequestLoggingInterceptor } from './common/request-logging.interceptor';
import { envValidationSchema } from './config/env.validation';
import { AssetUploadSessionEntity } from './database/entities/asset-upload-session.entity';
import { AssetVariantEntity } from './database/entities/asset-variant.entity';
import { AssetEntity } from './database/entities/asset.entity';
import { CategoryEntity } from './database/entities/category.entity';
import { CountryEntity } from './database/entities/country.entity';
import { FolderAccessGrantEntity } from './database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from './database/entities/folder-closure.entity';
import { FolderEntity } from './database/entities/folder.entity';
import { MediaRenderJobEntity } from './database/entities/media-render-job.entity';
import { OutboxEventEntity } from './database/entities/outbox-event.entity';
import { ProjectEvaluationSummaryEntity } from './database/entities/project-evaluation-summary.entity';
import { ProjectMediaEvaluationEntity } from './database/entities/project-media-evaluation.entity';
import { ProjectMediaEntity } from './database/entities/project-media.entity';
import { ProjectEntity } from './database/entities/project.entity';
import { ProvinceEntity } from './database/entities/province.entity';
import { TagEntity } from './database/entities/tag.entity';
import { HealthController } from './health/health.controller';
import { QueueModule } from './infra/queue/queue.module';
import { AssetsModule } from './modules/assets/assets.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CountriesModule } from './modules/countries/countries.module';
import { FoldersModule } from './modules/folders/folders.module';
import { MediaModule } from './modules/media/media.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ProvincesModule } from './modules/provinces/provinces.module';
import { TagsModule } from './modules/tags/tags.module';

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
