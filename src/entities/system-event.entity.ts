import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * 시스템 이벤트 테이블
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 9번 테이블 (개선된 네이밍)
 *
 * 역할: 시스템 이벤트와 데이터 변경 이력 추적
 * 특징: 직관적인 네이밍, 이벤트 기반 로깅, JSONB 페이로드
 */
@Entity('system_events')
@Index('ix_system_events_time', ['created_at'])
@Index('ix_system_events_entity', ['entity_type', 'entity_id', 'created_at'])
export class SystemEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'text' })
  event_name: string; // 'game_updated' | 'release_created' | 'followers_changed'

  @Column({ type: 'text' })
  entity_type: string; // 'game' | 'game_release' | 'game_detail'

  @Column({ type: 'bigint' })
  entity_id: number;

  @Column({ type: 'jsonb', nullable: true })
  event_data: any; // 변경 요약 및 추가 정보

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
