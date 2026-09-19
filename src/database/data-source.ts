import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { CategoryEntity } from './entities/category.entity';
import { CountryEntity } from './entities/country.entity';
import { FolderAccessGrantEntity } from './entities/folder-access-grant.entity';
import { FolderClosureEntity } from './entities/folder-closure.entity';
import { FolderEntity } from './entities/folder.entity';
import { ProjectEntity } from './entities/project.entity';
import { ProvinceEntity } from './entities/province.entity';
import { TagEntity } from './entities/tag.entity';
import { InitialPhaseOneMigration1710000000000 } from './migrations/1710000000000-initial-phase-one';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://aggo:aggo@localhost:55432/aggo',
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
  migrations: [InitialPhaseOneMigration1710000000000],
  synchronize: false,
});
