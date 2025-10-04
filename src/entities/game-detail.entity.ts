import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  Check
} from 'typeorm';
import { Game } from './game.entity';

/**
 * 게임 상세 메타데이터 테이블
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 2번 테이블
 *
 * 역할: 게임의 상세 정보와 미디어 데이터 관리
 * 특징: 인기도 40점 이상 게임만 저장, Steam+RAWG 통합 데이터
 */
@Entity('game_details')
@Index('ix_game_details_platform_type', ['platform_type'])
@Check('chk_screenshots_max5', 'array_length(screenshots, 1) <= 5')
export class GameDetail {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', unique: true })
  game_id: number;

  // ===== 미디어 (확실히 구할 수 있는 것만) =====
  @Column({ type: 'text', array: true, default: '{}' })
  screenshots: string[]; // 최대 5장

  @Column({ type: 'text', nullable: true })
  video_url: string | null; // YouTube 트레일러 URL

  // ===== 게임 정보 (Steam + RAWG 통합) =====
  @Column({ type: 'text', nullable: true })
  description: string | null; // 상세 설명

  @Column({ type: 'text', nullable: true })
  website: string | null; // 공식 웹사이트

  // ===== 분류 정보 (RAWG 우선) =====
  @Column({ type: 'text', array: true, default: '{}' })
  genres: string[]; // ['Action', 'RPG']

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[]; // ['Multiplayer', 'Co-op']

  @Column({ type: 'text', array: true, default: '{}' })
  support_languages: string[]; // 지원 언어

  // ===== 평점 정보 (확실히 구할 수 있는 것만) =====
  @Column({ type: 'integer', nullable: true })
  metacritic_score: number | null; // 메타크리틱 점수

  @Column({ type: 'integer', nullable: true })
  opencritic_score: number | null; // 오픈크리틱 점수

  @Column({ type: 'text', nullable: true })
  steam_review_desc: string | null; // Steam 리뷰 요약 설명

  // ===== Steam 통계 (AppDetails + AppReviews API) =====
  // ⚠️ steam_followers는 game_releases.followers로 통합 (단일 소스 원칙)



  // ===== RAWG 통계 =====
  @Column({ type: 'integer', nullable: true })
  rawg_added: number | null; // RAWG added 수

  @Column({ type: 'integer', nullable: true })
  total_reviews: number | null; // 총 리뷰 수 요약

  @Column({ type: 'text', nullable: true })
  review_score_desc: string | null; // 리뷰 점수 설명

  // ===== 플랫폼 타입 요약 (캐시) =====
  @Column({ type: 'text', nullable: true })
  platform_type: string | null; // 'pc' | 'console' | 'mixed'

  @Column({ type: 'text', default: '' })
  search_text: string; // PGroonga 검색용 텍스트 캐시

  // ===== 타임스탬프 =====
  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  // ===== 관계 설정 =====
  @OneToOne(() => Game, game => game.details, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'game_id' })
  game: Game;
}
