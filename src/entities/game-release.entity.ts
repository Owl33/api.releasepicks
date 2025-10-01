import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  Unique
} from 'typeorm';
import { Game } from './game.entity';
import { Platform, Store, ReleaseStatus } from './enums';

/**
 * 플랫폼별 출시 정보 테이블
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 3번 테이블
 *
 * 역할: 플랫폼/스토어별 출시 및 가격 정보 관리
 * 특징: 1:N 관계, 플랫폼별 세분화된 데이터 관리
 */
@Entity('game_releases')
@Index('ix_releases_calendar', ['release_date_date', 'platform', 'region', 'coming_soon'])
@Index('ix_releases_followers', ['followers'])
@Index('ix_releases_platform_store', ['platform', 'store', 'region'])
@Index('ix_releases_status', ['release_status', 'coming_soon'])
@Index('ix_releases_price', ['platform', 'region', 'current_price_cents'], { where: 'current_price_cents IS NOT NULL' })
@Unique('uq_game_platform_store_region_app', ['game_id', 'platform', 'store', 'region', 'store_app_id'])
export class GameRelease {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  game_id: number;

  // ===== 플랫폼/스토어 정보 =====
  @Column({
    type: 'enum',
    enum: Platform
  })
  platform: Platform;

  @Column({
    type: 'enum',
    enum: Store
  })
  store: Store;

  @Column({ type: 'text', nullable: true })
  store_app_id: string | null; // Steam AppID, PSN ID 등

  @Column({ type: 'text', nullable: true })
  store_url: string | null; // 스토어 링크

  // ===== 지역 정보 (글로벌 출시 지원) =====
  @Column({ type: 'char', length: 2, default: 'US' })
  region: string; // ISO 3166-1 alpha-2 (US, JP, KR, EU 등)

  // ===== 출시 정보 (플랫폼별로 다를 수 있음) =====
  @Column({ type: 'date', nullable: true })
  release_date_date: Date | null;

  @Column({ type: 'text', nullable: true })
  release_date_raw: string | null; // "Q4 2024", "Coming Soon"

  @Column({
    type: 'enum',
    enum: ReleaseStatus,
    nullable: true
  })
  release_status: ReleaseStatus | null;

  @Column({ type: 'boolean', default: false })
  coming_soon: boolean;

  // ===== 가격 정보 (구할 수 있을 때만) =====
  @Column({ type: 'integer', nullable: true })
  current_price_cents: number | null; // 센트 단위 가격

  @Column({ type: 'text', default: 'KRW' })
  currency: string;

  @Column({ type: 'boolean', default: false })
  is_free: boolean;

  // ===== Steam 전용 메트릭 (PC/Steam만, 스크레이핑으로 구함) =====
  @Column({ type: 'integer', nullable: true })
  followers: number | null; // 커뮤니티 팔로워

  @Column({ type: 'integer', nullable: true })
  reviews_total: number | null; // 총 리뷰 수

  @Column({ type: 'text', nullable: true })
  review_score_desc: string | null; // "Very Positive"

  // ===== 데이터 소스 추적 =====
  @Column({ type: 'text' })
  data_source: string; // 'steam' | 'rawg'

  // ===== 타임스탬프 =====
  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  // ===== 관계 설정 =====
  @ManyToOne(() => Game, game => game.releases, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'game_id' })
  game: Game;
}