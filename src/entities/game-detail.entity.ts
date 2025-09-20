import { Entity, PrimaryGeneratedColumn, Column, OneToOne, JoinColumn } from 'typeorm';
import { Game } from './game.entity';

@Entity('game_details')
export class GameDetail {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', unique: true })
  game_id: number;

  @Column({ type: 'text' })
  slug_name: string;

  @Column({ type: 'text', array: true, nullable: true })
  tags: string[];

  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true })
  rating: number;

  @Column({ type: 'boolean', nullable: true })
  early_access: boolean;

  @Column({ type: 'integer', nullable: true })
  ratings_count: number;

  @Column({ type: 'text', array: true, nullable: true })
  screenshots: string[];

  @Column({ type: 'jsonb', nullable: true })
  store_links: any;

  @Column({ type: 'text', nullable: true })
  esrb_rating: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'text', nullable: true })
  website: string;

  // 관계 설정
  @OneToOne(() => Game, game => game.gameDetail)
  @JoinColumn({ name: 'game_id' })
  game?: Game;
}