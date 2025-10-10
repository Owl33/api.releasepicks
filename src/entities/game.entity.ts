import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  OneToMany,
  ManyToOne,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
} from 'typeorm';
import { GameDetail } from './game-detail.entity';
import { GameRelease } from './game-release.entity';
import { GameCompanyRole } from './game-company-role.entity';
import { GameType, ReleaseStatus } from './enums';

/**
 * 게임 통합 정보 테이블 (핵심 테이블)
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 1번 테이블
 *
 * 역할: 게임의 기본 정보와 통합 메타데이터 관리
 * 특징: 외부 소스 ID 연결 + 인기도 시스템 중심
 */
@Entity('games')
@Index('ux_games_steam_id', ['steam_id'], {
  unique: true,
  where: 'steam_id IS NOT NULL',
})
@Index('ux_games_rawg_id', ['rawg_id'], {
  unique: true,
  where: 'rawg_id IS NOT NULL',
})
@Index('ix_games_popularity', ['popularity_score'])
@Index('ix_games_release_date', ['release_date_date', 'coming_soon'])
@Index('ix_games_coming_soon', ['coming_soon'])
@Index('ix_games_parent_steam', ['parent_steam_id'])
@Index('ix_games_parent_rawg', ['parent_rawg_id'])
@Index('ix_games_game_type_dlc', ['game_type'], {
  where: "game_type = 'dlc'",
})
@Index('ix_games_steam_last_refresh', ['steam_last_refresh_at'])
@Index('ix_games_rawg_last_refresh', ['rawg_last_refresh_at'])
export class Game {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'text' })
  name: string;
  @Column({ type: 'text' })
  og_name: string;

  @Column({ type: 'citext', unique: true })
  slug: string;

  @Column({ type: 'citext', unique: true })
  og_slug: string;
  // ===== 외부 소스 ID =====
  @Column({ type: 'integer', nullable: true })
  steam_id: number | null;

  @Column({ type: 'integer', nullable: true })
  rawg_id: number | null;

  // ===== 부모 게임 참조 (DLC → 본편 연결) =====
  @Column({ type: 'integer', nullable: true })
  parent_steam_id: number | null;

  @Column({ type: 'integer', nullable: true })
  parent_rawg_id: number | null;

  // ===== 게임 분류 =====
  @Column({
    type: 'enum',
    enum: GameType,
    default: GameType.GAME,
  })
  game_type: GameType;

  // ===== 대표 출시 정보 (가장 빠른 출시일 기준) =====
  @Column({ type: 'date', nullable: true })
  release_date_date: Date | null;

  @Column({ type: 'text', nullable: true })
  release_date_raw: string | null;

  @Column({
    type: 'enum',
    enum: ReleaseStatus,
    nullable: true,
  })
  release_status: ReleaseStatus | null;

  @Column({ type: 'boolean', default: false })
  coming_soon: boolean;

  // ===== 인기도 시스템 ⭐ (단순화) =====
  @Column({ type: 'integer', default: 0 })
  popularity_score: number; // 0-100 정규화된 점수 (tier는 이걸로 계산)

  // ===== 캐시된 요약 정보 =====
  @Column({ type: 'integer', nullable: true })
  followers_cache: number | null; // 대표 Steam 릴리스 팔로워 캐시

  @Column({ type: 'timestamptz', nullable: true })
  steam_last_refresh_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  rawg_last_refresh_at: Date | null;

  // ===== 타임스탬프 =====
  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  // ===== 관계 설정 =====

  // 부모 게임 관계 (DLC → 본편) - 임시 비활성화 (parent_steam_id/parent_rawg_id 사용 예정)
  // @ManyToOne(() => Game, (game) => game.children, { nullable: true })
  // parent: Game | null;

  // 자식 게임들 (본편 → DLC들)
  // @OneToMany(() => Game, (game) => game.parent)
  // children: Game[];

  // 상세 정보 (1:1)
  @OneToOne(() => GameDetail, (detail) => detail.game, { cascade: true })
  details: GameDetail | null;

  // 플랫폼별 출시 정보 (1:N)
  @OneToMany(() => GameRelease, (release) => release.game, { cascade: true })
  releases: GameRelease[];

  // 회사 관계 (N:M)
  @OneToMany(() => GameCompanyRole, (role) => role.game)
  company_roles: GameCompanyRole[];
}
