import { Entity, PrimaryGeneratedColumn, Column, OneToOne } from 'typeorm';
import { GameDetail } from './game-detail.entity';

@Entity('games')
export class Game {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint', unique: true })
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

  // 관계 설정 (1:1, games.id <- game_details.game_id)
  @OneToOne(() => GameDetail, gameDetail => gameDetail.game, { cascade: true })
  gameDetail?: GameDetail;
}