import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Steam 신규 제외 비트맵 버킷 테이블
 * - bucket_id: 8192개 단위 버킷 식별자
 * - bitmap: 제외 여부 비트맵 (기본)
 * - stats: 사유별 통계 + 사유별 비트맵(Base64 인코딩)
 * - last_updated_at: 마지막 갱신 시각
 */
@Entity('steam_excluded_registry')
export class SteamExcludedRegistry {
  @PrimaryColumn({ type: 'integer' })
  bucket_id: number;

  @Column({ type: 'bytea' })
  bitmap: Buffer;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  stats: unknown;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  last_updated_at: Date;
}
