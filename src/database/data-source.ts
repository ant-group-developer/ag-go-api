import { config as loadEnv } from 'dotenv';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { envValidationSchema } from '../config/env.validation';
import { AssetImportEntity } from './entities/asset-import.entity';
import { AssetUploadSessionEntity } from './entities/asset-upload-session.entity';
import { AssetVariantEntity } from './entities/asset-variant.entity';
import { AssetEntity } from './entities/asset.entity';
import { CategoryEntity } from './entities/category.entity';
import { CountryEntity } from './entities/country.entity';
import { DownloadJobItemEntity } from './entities/download-job-item.entity';
import { DownloadJobEntity } from './entities/download-job.entity';
import { DownloadLogEntity } from './entities/download-log.entity';
import { FolderAccessGrantEntity } from './entities/folder-access-grant.entity';
import { FolderClosureEntity } from './entities/folder-closure.entity';
import { FolderEntity } from './entities/folder.entity';
import { GoogleDriveConnectionEntity } from './entities/google-drive-connection.entity';
import { ImportBatchEntity } from './entities/import-batch.entity';
import { MediaRenderJobEntity } from './entities/media-render-job.entity';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { ProjectAuditLogEntity } from './entities/project-audit-log.entity';
import { ProjectEvaluationSummaryEntity } from './entities/project-evaluation-summary.entity';
import { ProjectMediaEvaluationEntity } from './entities/project-media-evaluation.entity';
import { ProjectMediaEntity } from './entities/project-media.entity';
import { ProjectEntity } from './entities/project.entity';
import { ProvinceEntity } from './entities/province.entity';
import { RenderBatchEntity } from './entities/render-batch.entity';
import { RenderProfileEntity } from './entities/render-profile.entity';
import { SystemLogEntity } from './entities/system-log.entity';
import { SystemSettingEntity } from './entities/system-setting.entity';
import { TagEntity } from './entities/tag.entity';
import { InitialPhaseOneMigration1710000000000 } from './migrations/1710000000000-initial-phase-one';
import { ProjectMediaMigration1720000000000 } from './migrations/1720000000000-project-media';
import { BackfillProjectSummariesMigration1730000000000 } from './migrations/1730000000000-backfill-project-summaries';
import { LocalUploadRenderMigration1740000000000 } from './migrations/1740000000000-local-upload-render';
import { UploadTargetProjectMigration1750000000000 } from './migrations/1750000000000-upload-target-project';
import { R2StorageDefaultsMigration1760000000000 } from './migrations/1760000000000-r2-storage-defaults';
import { UserOnlyAccessMigration1770000000000 } from './migrations/1770000000000-user-only-access';
import { AddCountryFlagUrl1780000000000 } from './migrations/1780000000000-add-country-flag-url';
import { ProjectMediaEvaluation1790000000000 } from './migrations/1790000000000-project-media-evaluation';
import { ProjectMediaEvaluationHistory1800000000000 } from './migrations/1800000000000-project-media-evaluation-history';
import { OutboxEvents1810000000000 } from './migrations/1810000000000-outbox-events';
import { AssetProcessingError1820000000000 } from './migrations/1820000000000-asset-processing-error';
import { UniqueCountryCode1830000000000 } from './migrations/1830000000000-unique-country-code';
import { MissingModules1840000000000 } from './migrations/1840000000000-missing-modules';
import { SettingsLogs1850000000000 } from './migrations/1850000000000-settings-logs';
import { LegacyWatermarkProfileMigration1860000000000 } from './migrations/1860000000000-legacy-watermark-profile';
import { ImportSourceMetadataMigration1870000000000 } from './migrations/1870000000000-import-source-metadata';
import { GoogleDriveImportDeduplicationMigration1880000000000 } from './migrations/1880000000000-google-drive-import-deduplication';
import { GoogleDriveImportDefaultPolicyMigration1890000000000 } from './migrations/1890000000000-google-drive-import-default-policy';
import { RenderSizesMigration1900000000000 } from './migrations/1900000000000-render-sizes';
import { BackfillImportedProjectStatusMigration1910000000000 } from './migrations/1910000000000-backfill-imported-project-status';
import { OutboxDeadStatusMigration1920000000000 } from './migrations/1920000000000-outbox-dead-status';

loadEnv();

const { error, value: validatedEnv } = envValidationSchema.validate(process.env, {
  abortEarly: false,
  allowUnknown: true,
});

if (error) {
  throw new Error(`Environment validation failed: ${error.message}`);
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: validatedEnv.DATABASE_URL,
  schema: validatedEnv.DATABASE_SCHEMA,
  entities: [
    AssetEntity,
    AssetUploadSessionEntity,
    AssetVariantEntity,
    FolderEntity,
    FolderClosureEntity,
    FolderAccessGrantEntity,
    CategoryEntity,
    CountryEntity,
    ProvinceEntity,
    TagEntity,
    ProjectEntity,
    ProjectMediaEntity,
    ProjectMediaEvaluationEntity,
    ProjectEvaluationSummaryEntity,
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
    OutboxEventEntity,
    SystemSettingEntity,
    SystemLogEntity,
  ],
  migrations: [
    InitialPhaseOneMigration1710000000000,
    ProjectMediaMigration1720000000000,
    BackfillProjectSummariesMigration1730000000000,
    LocalUploadRenderMigration1740000000000,
    UploadTargetProjectMigration1750000000000,
    R2StorageDefaultsMigration1760000000000,
    UserOnlyAccessMigration1770000000000,
    AddCountryFlagUrl1780000000000,
    ProjectMediaEvaluation1790000000000,
    ProjectMediaEvaluationHistory1800000000000,
    OutboxEvents1810000000000,
    AssetProcessingError1820000000000,
    UniqueCountryCode1830000000000,
    MissingModules1840000000000,
    SettingsLogs1850000000000,
    LegacyWatermarkProfileMigration1860000000000,
    ImportSourceMetadataMigration1870000000000,
    GoogleDriveImportDeduplicationMigration1880000000000,
    GoogleDriveImportDefaultPolicyMigration1890000000000,
    RenderSizesMigration1900000000000,
    BackfillImportedProjectStatusMigration1910000000000,
    OutboxDeadStatusMigration1920000000000,
  ],
  synchronize: false,
});
