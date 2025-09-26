import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { GameDetail } from './game-detail.entity';

@Entity('games')
export class Game {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', unique: true, name: 'rawg_id' })
  rawg_id: number;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'date' })
  released: Date;

  @Column({ type: 'text', array: true })
  platforms: string[];

  @Column({ type: 'text', array: true, nullable: true })
  genres: string[];

  @Column({ type: 'integer' })
  added: number;

  @Column({ type: 'text', nullable: true })
  image: string;

  @Column({ type: 'text', array: true, nullable: true })
  developers: string[];

  @Column({ type: 'text', array: true, nullable: true })
  publishers: string[];

  @Column({
    type: 'varchar',
    length: 20,
    default: 'upcoming',
    name: 'release_status',
  })
  release_status: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'pc',
    name: 'platform_type',
  })
  platform_type: string;

  @Column({
    type: 'char',
    length: 7,
    nullable: true,
    name: 'last_verified_month',
  })
  last_verified_month?: string;

  @Column({
    type: 'varchar',
    length: 32,
    nullable: true,
    name: 'last_synced_source',
  })
  last_synced_source?: string;

  // ===== Steam 통합 필드들 =====

  // Steam 기본 정보 (게임 캘린더 필수)
  @Column({ type: 'integer', nullable: true, name: 'steam_id' })
  steam_id?: number;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'korea_name' })
  korea_name?: string; // 한글 게임명

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'steam_price' })
  steam_price?: string; // "₩29,000" 형태

  @Column({ type: 'varchar', length: 20, nullable: true, name: 'steam_type' })
  steam_type?: string; // Steam 공식 타입: "game", "dlc", "music", "demo"

  @Column({ type: 'jsonb', nullable: true, name: 'fullgame_info' })
  fullgame_info?: object; // DLC인 경우 본편 게임 정보

  @Column({ type: 'integer', array: true, nullable: true, name: 'dlc_list' })
  dlc_list?: number[]; // 본편인 경우 DLC ID 목록

  @Column({
    type: 'integer',
    array: true,
    nullable: true,
    name: 'rawg_parent_ids',
  })
  rawg_parent_ids?: number[];

  // Steam 리뷰 (출시된 게임만)
  @Column({ type: 'integer', nullable: true, name: 'steam_reviews_positive' })
  steam_reviews_positive?: number;

  @Column({ type: 'integer', nullable: true, name: 'steam_reviews_total' })
  steam_reviews_total?: number;

  @Column({
    type: 'varchar',
    length: 50,
    nullable: true,
    name: 'steam_review_score',
  })
  steam_review_score?: string; // Steam 공식 review_score_desc: "압도적으로 긍정적" 등

  // ===== DLC 부모-자식 관계 필드들 =====

  // 부모 게임 관계 (DLC인 경우에만 값 존재)
  @Column({ type: 'integer', nullable: true, name: 'parent_game_id' })
  parent_game_id?: number; // 부모 게임의 games.id (DB PK)

  @Column({ type: 'integer', nullable: true, name: 'parent_steam_game_id' })
  parent_steam_game_id?: number; // 부모 게임의 Steam App ID

  // 자기 참조 관계: 부모 게임 (DLC → 본편)
  @ManyToOne(() => Game, (game) => game.children, { nullable: true })
  @JoinColumn({ name: 'parent_game_id' })
  parent?: Game;

  // 자기 참조 관계: 자식 게임들 (본편 → DLC들)
  @OneToMany(() => Game, (game) => game.parent)
  children?: Game[];

  // 관계 설정 (1:1, games.id <- game_details.game_id)
  @OneToOne(() => GameDetail, (gameDetail) => gameDetail.game, {
    cascade: true,
  })
  game_detail?: GameDetail;
}
