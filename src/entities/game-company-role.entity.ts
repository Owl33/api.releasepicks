import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  PrimaryColumn
} from 'typeorm';
import { Game } from './game.entity';
import { Company } from './company.entity';
import { CompanyRole } from './enums';

/**
 * 게임-회사 관계 테이블
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 5번 테이블
 *
 * 역할: 게임과 회사(개발사/퍼블리셔) 간의 N:M 관계 관리
 * 특징: 복합 PRIMARY KEY, 역할별 구분
 */
@Entity('game_company_role')
@Index('ix_game_company_role_company', ['company_id', 'role'])
export class GameCompanyRole {
  @PrimaryColumn({ type: 'bigint' })
  game_id: number;

  @PrimaryColumn({ type: 'bigint' })
  company_id: number;

  @PrimaryColumn({
    type: 'enum',
    enum: CompanyRole
  })
  role: CompanyRole; // 'developer' | 'publisher'

  // ===== 관계 설정 =====
  @ManyToOne(() => Game, game => game.company_roles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'game_id' })
  game: Game;

  @ManyToOne(() => Company, company => company.game_roles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company: Company;
}