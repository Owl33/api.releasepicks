/**
 * 파이프라인 관련 타입 정의
 */

import {
  GameType,
  ParentReferenceType,
  ReleaseStatus,
  Platform,
  Store,
  CompanyRole,
} from '../../entities/enums';

/**
 * 가공된 게임 데이터 인터페이스
 * Steam/RAWG 서비스에서 수집한 데이터를 Pipeline Controller로 전달하기 위한 구조
 */
export interface ProcessedGameData {
  // 기본 정보
  name: string;
  slug: string;
  steamId?: number;
  rawgId?: number;

  // 게임 분류
  gameType: GameType;
  parentSteamId?: number;
  parentRawgId?: number;
  parentReferenceType?: ParentReferenceType;

  // ===== Phase 5.5 추가: DLC 메타데이터 =====
  isDlc?: boolean; // DLC 여부
  platformType?: 'pc' | 'playstation' | 'xbox' | 'nintendo'; // 플랫폼 타입
  childDlcSteamIds?: number[]; // Steam 본편에서 수집한 DLC AppID 리스트 (백필용)

  // 출시 정보
  releaseDate?: Date | null;
  releaseDateRaw?: string;
  releaseStatus: ReleaseStatus;
  comingSoon: boolean;

  // 인기도
  popularityScore: number;
  followersCache?: number | null;

  // 플랫폼 요약
  platformsSummary: string[];

  // 회사 정보 (개발사/퍼블리셔)
  companies?: CompanyData[];

  // 상세 정보 (인기도 40점 이상만 포함, DLC는 제외)
  details?: GameDetailsData;

  // 플랫폼별 출시 정보 (본편만, DLC는 제외)
  releases?: GameReleaseData[];
}

/**
 * 회사 정보 데이터
 */
export interface CompanyData {
  name: string;
  slug?: string; // RAWG에서 제공하는 slug (있으면 사용, 없으면 자동 생성)
  role: CompanyRole; // 'developer' | 'publisher'
}

/**
 * 게임 상세 정보 데이터
 */
export interface GameDetailsData {
  // 미디어
  screenshots?: string[];
  videoUrl?: string;

  // 게임 정보
  description?: string;
  website?: string;

  // 분류 정보
  genres?: string[];
  tags?: string[];
  supportLanguages?: string[];

  headerImage: string;
  // 평점 정보
  metacriticScore?: number | null;
  opencriticScore?: number | null;

  // RAWG 통계
  rawgAdded?: number;
  totalReviews?: number;
  reviewScoreDesc?: string;
  // 플랫폼 타입 요약
  platformType?: 'pc' | 'console' | 'mixed';
}

/**
 * 게임 플랫폼별 출시 정보
 */
export interface GameReleaseData {
  // 플랫폼/스토어 정보
  platform: Platform;
  store: Store;
  storeAppId?: string;
  storeUrl?: string;
  // 출시 정보
  releaseDateDate?: Date | null;
  releaseDateRaw?: string;
  releaseStatus: ReleaseStatus;
  comingSoon: boolean;

  // 가격 정보
  currentPriceCents?: number;
  isFree: boolean;

  // Steam 전용 메트릭
  followers?: number;
  reviewsTotal?: number;
  reviewScoreDesc?: string;

  // 데이터 소스
  dataSource: 'steam' | 'rawg';
}

/**
 * 파이프라인 실행 결과
 */
export interface PipelineRunResult {
  pipelineRunId: number;
  phase: 'steam' | 'rawg' | 'full';
  totalProcessed: number;
  finishedAt: Date;
  refreshSummary?: {
    totalCandidates: number;
    processed: number;
    saved: number;
    failed: number;
    dryRun: boolean;
    candidates: SteamRefreshCandidate[];
  };
  rawgReport?: any;
}

/**
 * API 응답 인터페이스
 */
export interface ApiResponse<T> {
  statusCode: number;
  message: string;
  data?: T;
}

/**
 * 기존 게임 정보 맵 (우선순위 선별용)
 * DB에서 조회한 기존 게임 정보를 메모리에 저장
 */
export type ExistingGamesMap = Map<
  number,
  {
    steam_id: number;
    coming_soon?: boolean | null;
    release_date_date?: Date | null;
    followers_cache?: number | null;
    popularity_score?: number | null;
  }
>;

/**
 * 우선순위 선별 옵션
 */
export interface PrioritySelectionOptions {
  limit: number;
  mode: 'bootstrap' | 'operational'; // 명시적 모드 구분
  existingGames?: ExistingGamesMap; // 옵셔널: Operational 모드에서만 사용
}

/**
 * Steam 데이터 수집 옵션
 */
export interface SteamCollectOptions {
  mode: 'bootstrap' | 'operational';
  limit: number;
  strategy?: 'latest' | 'priority';
}

/**
 * Steam 출시 윈도우 갱신 후보 정보
 */
export interface SteamRefreshCandidate {
  gameId: number;
  steamId: number;
  name: string;
  slug: string;
}
