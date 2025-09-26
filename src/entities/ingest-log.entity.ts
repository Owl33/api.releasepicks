import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import type { IngestStatus } from '../types/domain.types';

@Entity('ingest_logs')
export class IngestLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({
    type: 'timestamp with time zone',
    name: 'executed_at',
  })
  executed_at: Date;

  @Column({ type: 'jsonb', nullable: true })
  context?: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20 })
  status: IngestStatus;

  @Column({
    type: 'jsonb',
    nullable: true,
    name: 'affected_games',
  })
  affected_games?: {
    total?: number;
    updated?: number;
    skipped?: number;
    failed?: number;
  };

  @Column({ type: 'jsonb', nullable: true })
  details?: unknown;
}
