import {
  Entity,
  Column,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';

/**
 * 데이터 동기화 상태 테이블
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 6번 테이블 (개선된 네이밍)
 *
 * 역할: 데이터 파이프라인의 진행 상태와 체크포인트 관리
 * 특징: 직관적인 네이밍, Key-Value 구조, JSONB 활용
 */
@Entity('data_sync_status')
export class DataSyncStatus {
  @PrimaryColumn({ type: 'text' })
  sync_name: string; // 'steam_applist_last_sync', 'rawg_sync_checkpoint' 등

  @Column({ type: 'jsonb' })
  sync_data: any; // 동기화 관련 데이터 (마지막 처리 ID, 타임스탬프 등)

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}