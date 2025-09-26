import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Game } from './game.entity';

@Entity('game_details')
export class GameDetail {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', unique: true, name: 'game_id' })
  game_id: number;

  @Column({ type: 'text', name: 'slug_name' })
  slug_name: string;

  @Column({ type: 'text', array: true, nullable: true })
  tags: string[];

  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true })
  rating: number;

  @Column({ type: 'boolean', nullable: true, name: 'early_access' })
  early_access?: boolean;

  @Column({ type: 'integer', nullable: true, name: 'ratings_count' })
  ratings_count?: number;

  @Column({ type: 'text', array: true, nullable: true })
  screenshots: string[];

  @Column({ type: 'jsonb', nullable: true, name: 'store_links' })
  store_links?: any;

  @Column({ type: 'text', nullable: true, name: 'esrb_rating' })
  esrb_rating?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'text', nullable: true })
  website?: string;

  // ===== Steam 통합 필드들 =====

  // Steam 한글 콘텐츠
  @Column({ type: 'text', nullable: true, name: 'korean_description' })
  korean_description?: string; // 한글 설명

  @Column({
    type: 'text',
    array: true,
    nullable: true,
    name: 'steam_categories',
  })
  steam_categories?: string[]; // Steam 카테고리

  // 관계 설정
  @OneToOne(() => Game, (game) => game.game_detail)
  @JoinColumn({ name: 'game_id' })
  game?: Game;
}
