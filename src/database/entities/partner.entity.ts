import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const PARTNER_STATUSES = ['active', 'inactive'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/**
 * A partner (CTV) of AG Go: a thin record over an AG Account user. Personal data (ID card, birth
 * date, address, phone, tax and bank numbers) stays in AG Account and is read through its
 * contract-profile API; only the display name is cached here (kept fresh by webhooks).
 */
@Entity('partners')
export class PartnerEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** AG Account's own user id, used for every contract-profile call. */
  @Column({ name: 'account_user_id', type: 'varchar', length: 36 })
  accountUserId!: string;

  /** AG Go user id (token subject without `auth0|`), matching `projects.owner_user_id`. */
  @Column({ name: 'go_user_id', type: 'varchar', length: 128 })
  goUserId!: string;

  /** Initials used in contract numbers, e.g. `NHH` in `010826/HĐSXND/AG-NHH`. */
  @Column({ type: 'varchar', length: 20 })
  code!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 200 })
  displayName!: string;

  @Column({ name: 'manager_user_id', type: 'varchar', length: 128 })
  managerUserId!: string;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: PartnerStatus;

  /** Last time the AG Account profile was found complete enough to sign a contract. */
  @Column({ name: 'profile_checked_at', type: 'timestamptz', nullable: true })
  profileCheckedAt!: Date | null;

  /**
   * Required profile fields found missing at the last check (empty = complete); null when never
   * checked or when AG Account reported a change since.
   */
  @Column({ name: 'profile_missing_fields', type: 'jsonb', nullable: true })
  profileMissingFields!: string[] | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
