import {
  GameType,
  ParentReferenceType,
  ReleaseStatus,
  Platform,
  Store,
  CompanyRole,
} from '../../entities/enums';

export type { SteamRefreshCandidate } from './collector/steam';

/**
 * Collector → Orchestrator → Persistence 간에 공유되는 게임 기본 데이터 계약
 */
export interface ProcessedGameData {
  // 기본 정보
  name: string;
  slug?: string;
  ogName: string;
  ogSlug?: string;
  steamId?: number;
  rawgId?: number;

  // 게임 분류
  gameType: GameType;
  parentSteamId?: number;
  parentRawgId?: number;
  parentReferenceType?: ParentReferenceType;

  // DLC 메타데이터
  childDlcSteamIds?: number[];

  // 출시 정보
  releaseDate?: Date | null;
  releaseDateRaw?: string;
  releaseStatus: ReleaseStatus;
  comingSoon: boolean;

  // 인기도
  popularityScore: number;
  followersCache?: number | null;

  // 회사 정보
  companies?: CompanyData[];

  // 상세 정보 (인기도 40점 이상만 포함, DLC 제외)
  details?: GameDetailsData;

  // 플랫폼별 출시 정보 (본편만)
  releases?: GameReleaseData[];

  // 멀티 플랫폼 매칭 힌트
  matchingContext?: MatchingContextData;
  matchingDecision?: MatchingDecisionData;
}

export interface CompanyData {
  name: string;
  slug?: string;
  role: CompanyRole;
}

export interface GameDetailsData {
  screenshots?: string[];
  videoUrl?: string;
  description?: string;
  website?: string;
  genres?: string[];
  tags?: string[];
  supportLanguages?: string[];
  sexual: boolean;
  headerImage: string;
  metacriticScore?: number | null;
  opencriticScore?: number | null;
  rawgAdded?: number;
  totalReviews?: number;
  reviewScoreDesc?: string;
}

export interface GameReleaseData {
  platform: Platform;
  store: Store;
  storeAppId?: string;
  storeUrl?: string;
  releaseDateDate?: Date | null;
  releaseDateRaw?: string;
  releaseStatus: ReleaseStatus;
  comingSoon: boolean;
  currentPriceCents?: number;
  isFree: boolean;
  followers?: number;
  reviewsTotal?: number;
  reviewScoreDesc?: string;
  dataSource: 'steam' | 'rawg';
}

/**
 * Collector가 Persistence 계층에 전달하는 매칭 보조 정보
 */
export interface MatchingContextData {
  source: 'steam' | 'rawg';
  normalizedName?: {
    lowercase: string;
    tokens: string[];
    compact: string;
    looseSlug?: string;
  };
  releaseDateIso?: string | null;
  companySlugs?: string[];
  genreTokens?: string[];
  candidateSlugs?: string[];
  candidateSteamIds?: number[];
  canonicalSteamId?: number;
  existingRawgIds?: number[];
}

export type MatchingDecisionStatus = 'auto' | 'pending' | 'rejected';

/**
 * Persistence 계층이 Collector/CLI에 반환하는 매칭 결과 요약
 */
export interface MatchingDecisionData {
  status: MatchingDecisionStatus;
  matchedGameId?: number;
  matchedScore?: number;
  reason?: string;
  logPath?: string;
}
