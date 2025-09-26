/**
 * 도메인 전역에서 사용하는 기본 타입 정의 모음
 * Stage 1 도메인 계약(`docs/domain-contract.md`)을 기준으로 작성
 */

export type ReleaseStatus = 'upcoming' | 'delayed' | 'released' | 'cancelled';

export type PlatformType = 'pc' | 'console' | 'mixed';

export type GameTypeValue =
  | 'main_game'
  | 'dlc'
  | 'edition'
  | 'port'
  | 'standalone';

export type IngestStatus = 'success' | 'partial' | 'failed';

export interface GameStoreLinks {
  steam?: string;
  playstation?: string;
  xbox?: string;
  nintendo?: string;
  epic?: string;
  gog?: string;
}

export interface SteamReviewSummary {
  review_score?: number;
  review_score_desc?: string;
  total_positive?: number;
  total_negative?: number;
  total_reviews?: number;
}

export interface MetacriticSummary {
  score: number;
  url: string;
}
