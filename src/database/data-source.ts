import { config as loadEnv } from 'dotenv';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { envValidationSchema } from '../config/env.validation';
import { AssetUploadSessionEntity } from './entities/asset-upload-session.entity';
import { AssetVariantEntity } from './entities/asset-variant.entity';
import { AssetEntity } from './entities/asset.entity';
import { CategoryEntity } from './entities/category.entity';
import { CountryEntity } from './entities/country.entity';
import { FolderAccessGrantEntity } from './entities/folder-access-grant.entity';
import { FolderClosureEntity } from './entities/folder-closure.entity';
import { FolderEntity } from './entities/folder.entity';
import { MediaRenderJobEntity } from './entities/media-render-job.entity';
import { ProjectEvaluationSummaryEntity } from './entities/project-evaluation-summary.entity';
import { ProjectMediaEntity } from './entities/project-media.entity';
import { ProjectEntity } from './entities/project.entity';
import { ProvinceEntity } from './entities/province.entity';
import { TagEntity } from './entities/tag.entity';
import { InitialPhaseOneMigration1710000000000 } from './migrations/1710000000000-initial-phase-one';
import { ProjectMediaMigration1720000000000 } from './migrations/1720000000000-project-media';
import { BackfillProjectSummariesMigration1730000000000 } from './migrations/1730000000000-backfill-project-summaries';
import { LocalUploadRenderMigration1740000000000 } from './migrations/1740000000000-local-upload-render';
import { UploadTargetProjectMigration1750000000000 } from './migrations/1750000000000-upload-target-project';
import { R2StorageDefaultsMigration1760000000000 } from './migrations/1760000000000-r2-storage-defaults';
import { UserOnlyAccessMigration1770000000000 } from './migrations/1770000000000-user-only-access';

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
    ProjectEvaluationSummaryEntity,
    MediaRenderJobEntity,
  ],
  migrations: [
    InitialPhaseOneMigration1710000000000,
    ProjectMediaMigration1720000000000,
    BackfillProjectSummariesMigration1730000000000,
    LocalUploadRenderMigration1740000000000,
    UploadTargetProjectMigration1750000000000,
    R2StorageDefaultsMigration1760000000000,
    UserOnlyAccessMigration1770000000000,
  ],
  synchronize: false,
});
