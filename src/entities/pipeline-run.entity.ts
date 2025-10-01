import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  Index,
  CreateDateColumn,
  UpdateDateColumn
} from 'typeorm';
import { PipelineItem } from './pipeline-item.entity';

/**
 * 파이프라인 실행 기록 테이블
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 7번 테이블 (개선된 네이밍)
 *
 * 역할: 데이터 파이프라인 실행 상태와 통계 추적
 * 특징: 직관적인 네이밍, 파이프라인별 성과 측정
 */
@Entity('pipeline_runs')
@Index('ix_pipeline_runs_type_time', ['pipeline_type', 'started_at'])
export class PipelineRun {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'text' })
  pipeline_type: string; // 'steam_applist_sync' | 'rawg_matching' | 'followers_update'

  @Column({ type: 'text', default: 'queued' })
  status: string; // 'queued' | 'running' | 'completed' | 'failed'

  @Column({ type: 'integer', default: 0 })
  total_items: number; // 처리할 전체 아이템 수

  @Column({ type: 'integer', default: 0 })
  completed_items: number; // 성공한 아이템 수

  @Column({ type: 'integer', default: 0 })
  failed_items: number; // 실패한 아이템 수

  @Column({ type: 'text', nullable: true })
  summary_message: string | null; // 실행 요약 메시지

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  started_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  // ===== 관계 설정 =====
  @OneToMany(() => PipelineItem, item => item.pipeline_run)
  items: PipelineItem[];
}