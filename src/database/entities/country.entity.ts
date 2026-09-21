import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('countries')
@Index('uq_countries_code', ['code'], { unique: true })
export class CountryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  code!: string | null;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'flag_url', type: 'varchar', length: 500, nullable: true })
  flagUrl!: string | null;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
