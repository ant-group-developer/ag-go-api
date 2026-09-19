import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('folder_closure')
export class FolderClosureEntity {
  @PrimaryColumn({ name: 'ancestor_id', type: 'uuid' })
  ancestorId!: string;

  @PrimaryColumn({ name: 'descendant_id', type: 'uuid' })
  descendantId!: string;

  @Column({ type: 'integer', default: 0 })
  depth!: number;
}
