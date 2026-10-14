import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Stored status; `completed` is derived on read (running with nothing left to do). */
export type AssetPrepBatchStatus = 'running' | 'paused' | 'cancelled';

/**
 * A prep backfill: its farm jobs share the group key `prep-batch:<id>`, so the whole batch is
 * paused, resumed or cancelled at once. New footage and Studio requests run without a batch.
 */
@Entity('asset_prep_batches')
export class AssetPrepBatchEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  /** `missing` | `all`. */
  @Column({ type: 'varchar', length: 20 })
  mode!: string;

  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @Column({ type: 'varchar', length: 20, default: 'running' })
  status!: AssetPrepBatchStatus;

  @Column({ name: 'created_by', type: 'varchar', length: 128, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
