import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('tags')
export class TagEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'normalized_name', type: 'varchar', length: 100 })
  normalizedName!: string;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;
}
