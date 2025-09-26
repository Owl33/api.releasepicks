import {
  GameStoreLinks,
  GameTypeValue,
  MetacriticSummary,
  PlatformType,
  ReleaseStatus,
  SteamReviewSummary,
} from './domain.types';

/**
 * 게임 캘린더 파이프라인에서 사용하는 통합 타입 정의
 * Stage 1 도메인 계약 및 Stage 2 설계 문서를 기준으로 작성
 */

/**
 * API 응답 공통 형식
 */
export interface ApiResponse<T> {
  success: boolean;
  message?: string;
  data: T;
  timestamp?: string;
}

/**
 * RAWG 월별 리스트 기본 정보
 */
export interface RawgListGame {
  id: number;
  slug: string;
  name: string;
  released: string | null;
  tba: boolean;
  background_image?: string | null;
  parent_platforms?: any[];
  platforms?: any[];
  genres?: any[];
  tags?: any[];
  added?: number;
  added_by_status?: Record<string, number>;
  rating?: number;
  ratings_count?: number;
  esrb_rating?: { name?: string } | null;
  description_raw?: string | null;
  short_screenshots?: Array<{
    id?: number;
    image?: string;
    path_full?: string;
  }>;
  is_free?: boolean;
}

/**
 * RAWG 상세 정보 구조
 */
export interface RawgGameDetail {
  slugName: string;
  website?: string | null;
  developers: string[];
  publishers: string[];
  parents_count?: number;
  additions_count?: number;
}

/**
 * RAWG 스토어 정보 구조
 */
export interface RawgGameStore {
  id: number;
  store: {
    id: number;
    slug: string;
    name: string;
  };
  url: string;
}

/**
 * RAWG 미디어(트레일러 등) 정보
 */
export interface RawgMediaInfo {
  youtubeUrl?: string;
  previewImage?: string;
}

/**
 * RawgCollector 실행 옵션
 */
export interface RawgCollectorOptions {
  maxGames: number;
  minPopularity: number;
  includeEarlyAccess: boolean;
  enableTrailers: boolean;
}

/**
 * RawgCollector가 반환하는 게임 단위 DTO
 */
export interface RawgCollectedGame {
  base: RawgListGame;
  detail?: RawgGameDetail | null;
  stores?: RawgGameStore[] | null;
  media?: RawgMediaInfo | null;
  parent_rawg_id?: number | null;
  steamStoreId?: number | null;
  steamStoreUrl?: string | null;
  failures?: string[];
}

/**
 * RawgCollector 실행 결과
 */
export interface RawgCollectorResult {
  month: string;
  totalCandidates: number;
  deliveredGames: RawgCollectedGame[];
  apiCallStats: {
    list: number;
    details: number;
    stores: number;
    parents: number;
    trailers: number;
    retries: number;
    failures: number;
  };
}

/**
 * 통합 게임 캘린더 데이터 (API 응답 + 내부 파이프라인 공통)
 */
export interface CollectionStats {
  rawg_api_calls: number;
  steam_api_calls: number;
  steam_success_rate: number;
  processing_time_ms: number;
  dlc_filtered: number;
}

export interface GameCalendarData {
  /** 식별자 */
  rawg_id: number;
  steam_id?: number | null;

  /** 기본 정보 */
  name: string;
  original_name?: string | null;
  slug_name?: string | null;
  release_date: string | null;
  release_status: ReleaseStatus;
  tba: boolean;
  platform_type: PlatformType;
  platforms: string[];
  genres: string[];
  tags: string[];
  developers: string[];
  publishers: string[];

  /** 메타 정보 */
  rating?: number;
  ratings_count?: number;
  esrb_rating?: string | null;
  required_age?: string | null;
  early_access?: boolean;
  description?: string | null;
  korean_description?: string | null;
  website?: string | null;
  categories?: string[];

  /** 미디어 */
  image?: string | null;
  screenshots: string[];
  trailer_url?: string | null;

  /** 상점/가격 */
  store_links: GameStoreLinks;
  price?: string | null;
  currency?: string | null;

  /** Steam 관련 */
  steam_integrated: boolean;
  steam_type?: string | null;
  korea_name?: string | null;
  is_full_game?: boolean;
  dlc_list?: number[];
  is_free?: boolean;

  /** 리뷰/평판 */
  review_summary?: SteamReviewSummary;
  metacritic?: MetacriticSummary | null;

  /** 출시 관계 */
  is_dlc: boolean;
  parent_rawg_id?: number | null;
  parent_steam_id?: number | null;
  game_type?: GameTypeValue;
  game_type_confidence?: number | null;
  game_type_reason?: string | null;

  /** 동기화 정보 */
  last_verified_month?: string | null;
  last_synced_source?: string | null;

  /** 원본 RAWG 지표 (내부 사용) */
  added?: number;
  added_by_status?: Record<string, number>;

  /** 파이프라인 보조 필드 (DLC 확장 등) */
  dlc_context?: {
    rawg_parent_ids?: number[];
    steam_fullgame_info?: {
      appid?: string;
      name?: string;
      [key: string]: unknown;
    } | null;
  };
}

/**
 * 월별 통합 게임 수집 결과
 */
export interface MonthlyUnifiedGameResult {
  month: string;
  total_games: number;
  pc_games: number;
  console_games: number;
  steam_integrated_games: number;
  games: GameCalendarData[];
  collection_stats: CollectionStats;
}

/**
 * 통합 게임 처리 옵션
 */
export interface UnifiedGameOptions {
  max_games?: number;
  enable_steam_integration?: boolean;
  min_popularity?: number;
  include_early_access?: boolean;
  steam_timeout?: number;
}

/**
 * 게임 캘린더 필터링 옵션
 */
export interface CalendarFilters {
  month: string;
  platforms?: string[];
  genres?: string[];
  min_popularity?: number;
  only_with_trailers?: boolean;
  sort_by?: 'release_date' | 'popularity' | 'name';
  sort_order?: 'asc' | 'desc';
}

/**
 * RAWG additions API 응답
 */
export interface RawgAdditionData {
  id: number;
  name: string;
  slug: string;
  platforms: any[];
  background_image: string;
}

/**
 * 플랫폼 처리 전략 타입
 */
export type PlatformStrategy = 'rawg-only' | 'steam-enhanced';

/**
 * 플랫폼별 처리 정보
 */
export interface PlatformProcessingInfo {
  strategy: PlatformStrategy;
  reason: string;
  steamEligible: boolean;
}

/**
 * Stage 1 레거시의 StoreLinks 호환을 위한 임시 alias
 * (새로운 코드에서는 GameStoreLinks 사용 권장)
 */
export type StoreLinks = GameStoreLinks;

export default GameCalendarData;
