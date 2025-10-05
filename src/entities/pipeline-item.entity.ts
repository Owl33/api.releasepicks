import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { PipelineRun } from './pipeline-run.entity';

/**
 * 파이프라인 작업 항목 테이블
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 8번 테이블 (개선된 네이밍)
 *
 * 역할: 개별 파이프라인 작업 항목의 실행 상태와 성능 추적
 * 특징: 직관적인 네이밍, 세부 실행 로그, 오류 추적, 성능 측정
 */
@Entity('pipeline_items')
@Index('ix_pipeline_items_run', ['pipeline_run_id'])
@Index('ix_pipeline_items_target', ['target_type', 'target_id'])
export class PipelineItem {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  pipeline_run_id: number;

  @Column({ type: 'text' })
  target_type: string; // 'game' | 'release' | 'steam_app'

  @Column({ type: 'bigint', nullable: true })
  target_id: number | null; // games.id 또는 game_releases.id

  @Column({ type: 'text' })
  action_name: string; // 'fetch_followers' | 'sync_rawg_data' | 'update_details'

  @Column({ type: 'text', default: 'pending' })
  status: string; // 'pending' | 'running' | 'completed' | 'failed'

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @Column({ type: 'integer', nullable: true })
  execution_time_ms: number | null; // 실행 시간 (밀리초)

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  // ===== 관계 설정 =====
  @ManyToOne(() => PipelineRun, (run) => run.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pipeline_run_id' })
  pipeline_run: PipelineRun;
}
