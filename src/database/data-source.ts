import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AssetEntity } from './entities/asset.entity';
import { CategoryEntity } from './entities/category.entity';
import { CountryEntity } from './entities/country.entity';
import { FolderAccessGrantEntity } from './entities/folder-access-grant.entity';
import { FolderClosureEntity } from './entities/folder-closure.entity';
import { FolderEntity } from './entities/folder.entity';
import { ProjectEvaluationSummaryEntity } from './entities/project-evaluation-summary.entity';
import { ProjectMediaEntity } from './entities/project-media.entity';
import { ProjectEntity } from './entities/project.entity';
import { ProvinceEntity } from './entities/province.entity';
import { TagEntity } from './entities/tag.entity';
import { InitialPhaseOneMigration1710000000000 } from './migrations/1710000000000-initial-phase-one';
import { ProjectMediaMigration1720000000000 } from './migrations/1720000000000-project-media';
import { BackfillProjectSummariesMigration1730000000000 } from './migrations/1730000000000-backfill-project-summaries';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://aggo:aggo@localhost:55432/aggo',
  entities: [
    AssetEntity,
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
  ],
  migrations: [
    InitialPhaseOneMigration1710000000000,
    ProjectMediaMigration1720000000000,
    BackfillProjectSummariesMigration1730000000000,
  ],
  synchronize: false,
});
