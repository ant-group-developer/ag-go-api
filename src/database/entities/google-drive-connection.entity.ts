import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('google_drive_connections')
export class GoogleDriveConnectionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 128 })
  externalUserId!: string;

  @Column({ name: 'google_subject', type: 'varchar', length: 255 })
  googleSubject!: string;

  @Column({ name: 'encrypted_refresh_token', type: 'text' })
  encryptedRefreshToken!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  scopes!: string[];

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: 'active' | 'revoked' | 'error';

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
