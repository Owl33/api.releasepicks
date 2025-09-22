import { Entity, PrimaryGeneratedColumn, Column, OneToOne } from 'typeorm';
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

  // Steam 리뷰 (출시된 게임만)
  @Column({ type: 'integer', nullable: true, name: 'steam_reviews_positive' })
  steam_reviews_positive?: number;

  @Column({ type: 'integer', nullable: true, name: 'steam_reviews_total' })
  steam_reviews_total?: number;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'steam_review_score' })
  steam_review_score?: string; // Steam 공식 review_score_desc: "압도적으로 긍정적" 등

  // 관계 설정 (1:1, games.id <- game_details.game_id)
  @OneToOne(() => GameDetail, (gameDetail) => gameDetail.game, {
    cascade: true,
  })
  game_detail?: GameDetail;
}
