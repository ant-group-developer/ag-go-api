import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('provinces')
export class ProvinceEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'country_id', type: 'uuid' })
  countryId!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  code!: string | null;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
