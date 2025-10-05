import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GameCompanyRole } from './game-company-role.entity';

/**
 * 회사 마스터 테이블
 * FINAL-ARCHITECTURE-DESIGN 명세 기반 - 4번 테이블
 *
 * 역할: 게임 개발사/퍼블리셔 정보 관리
 * 특징: 단순한 마스터 테이블, 중복 제거
 */
@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'text', unique: true })
  name: string;

  @Column({ type: 'citext', unique: true })
  slug: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  // ===== 관계 설정 =====
  @OneToMany(() => GameCompanyRole, (role) => role.company)
  game_roles: GameCompanyRole[];
}
