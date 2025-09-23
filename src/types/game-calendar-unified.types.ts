/**
 * 통합 게임 캘린더 데이터 타입 정의
 * user_request.md 명세 기준으로 완전히 새로 작성
 *
 * 처리 전략:
 * - PC 게임: RAWG + Steam 통합
 * - 콘솔 전용 (PS, Nintendo): RAWG만 사용
 * - 리뷰 데이터: Steam Reviews API에서 직접 추가
 * - DLC 필터링: parent_count 활용
 */


/**
 * 게임 스토어 링크 모음
 */
export interface StoreLinks {
  steam?: string;
  gog?: string;
  epic?: string;
  playstation?: string;
  xbox?: string;
  nintendo?: string;
}

/**
 * API 응답 공통 형식
 */
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
  timestamp?: string;
}

/**
 * 최종 통합 게임 캘린더 데이터
 * user_request.md의 명세를 완전히 구현
 */
export interface GameCalendarData {
  // ===== RAWG 기본 정보 =====
  /** RAWG의 id 사용 */
  rawg_id: number;

  /** RAWG의 네임 그대로 사용 */
  name: string;

  /** 스팀에서 제공하는 required_age */
  required_age: string;

  /** 출시일 */
  released: string;

  /** To Be Announced */
  tba: boolean;

  /** 플랫폼 목록 */
  platforms: string[];

  /** 기존 rawg.genres 그대로 사용 */
  genres: string[];

  /** 태그 */
  tags: string[];

  /** 얼리 액세스 여부 */
  early_access: boolean;

  /** Steam에서 제공하는 header_image, 없다면 rawg의 기존 rawgGame.background_image 사용 */
  image: string;

  // ===== 인기도 및 상태 =====
  /** RAWG added */
  added: number;

  /** RAWG added_by_status */
  added_by_status?: any;

  /** Steam의 screenshots이 있다면 path_full만 저장, 없다면 rawg 스크린샷 사용 */
  screenshots: SteamScreenshot[] | string[];

  // ===== 평점 및 등급 =====
  /** ESRB 등급 */
  esrb_rating: string | null;

  /** RAWG 평점 */
  rating: number;

  /** RAWG 평점 개수 */
  ratings_count: number;

  /** 게임 설명 */
  description?: string;

  // ===== Steam 메타크리틱 =====
  /** Steam에서 metacritic 사용 */
  metacritic?: {
    score: number;
    url: string;
  };

  /** Steam.categories로 옴, description만 담아서 저장 */
  categories: string[];

  // ===== 개발사/배급사 정보 =====
  /** RAWG slug name */
  slug_name?: string;

  /** Steam에서 제공하는 website, 없다면 rawg에서 제공하는 것 사용 */
  website?: string;

  /** Steam에서 제공되는 developers, 없다면 RAWG */
  developers: string[];

  /** Steam에서 제공되는 publishers, 없다면 RAWG */
  publishers: string[];

  // ===== 미디어 및 링크 =====
  /** 스토어 링크 */
  store_links?: StoreLinks;

  /** YouTube URL */
  video?: string;

  // ===== Steam 리뷰 관련 (user_request.md 명세) =====
  /** 리뷰 점수 */
  review_score?: number;

  /** "압도적으로 긍정적", "매우 긍정적" 등 */
  review_score_desc?: string;

  /** 긍정적 리뷰 수 */
  total_positive?: number;

  /** 부정적 리뷰 수 */
  total_negative?: number;

  /** 전체 리뷰 수 */
  total_reviews?: number;

  // ===== Steam 통합 필드들 (플랫 구조) =====
  /** Steam ID */
  steam_id?: number;

  /** Steam 원본 영문명 */
  original_name?: string;

  /** Steam 한글명 */
  korea_name?: string;

  /** Steam 게임 타입 (game, dlc, demo 등) */
  steam_type?: string;

  /** Steam 가격 정보 */
  price?: string;

  /** 본편 게임 여부 */
  is_full_game?: boolean;

  /** DLC 목록 (본편인 경우) */
  dlc_list?: number[];

  /** 무료 게임 여부 */
  is_free?: boolean;

  /** DLC 여부 (통합 분석 결과) */
  is_dlc?: boolean;

  /** 게임 타입 분류 (통합 분석 결과) */
  game_type?: 'main_game' | 'dlc' | 'edition' | 'port' | 'standalone';

  /** 게임 타입 분석 신뢰도 (0-1) */
  game_type_confidence?: number;

  /** 게임 타입 분석 근거 */
  game_type_reason?: string;

  // ===== 메타 정보 =====
  /** 플랫폼 타입 */
  platform_type: 'pc' | 'console' | 'mixed';

  /** Steam 통합 여부 */
  steam_integrated: boolean;
}

/**
 * Steam 스크린샷 데이터
 * Steam에서 제공하는 형태
 */
export interface SteamScreenshot {
  id: number;
  path_thumbnail: string;
  path_full: string;
}

// Steam 타입들이 이제 플랫 구조로 통합됨

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
  collection_stats: {
    rawg_api_calls: number;
    steam_api_calls: number;
    steam_success_rate: number;
    processing_time_ms: number;
    dlc_filtered: number;
  };
}

/**
 * 통합 게임 처리 옵션
 */
export interface UnifiedGameOptions {
  /** 최대 게임 수 */
  max_games?: number;

  /** Steam 통합 활성화 (PC 게임만) */
  enable_steam_integration?: boolean;

  /** 최소 인기도 (RAWG added) */
  min_popularity?: number;


  /** 얼리 액세스 포함 */
  include_early_access?: boolean;

  /** Steam API 타임아웃 */
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
 * RAWG parent-games API 응답
 */
export interface RawgParentGameData {
  id: number;
  name: string;
  slug: string;
  platforms: any[];
  background_image: string;
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
 * Steam 리뷰 API 응답 (store.steampowered.com/appreviews)
 */
export interface SteamReviewData {
  review_score?: number;
  review_score_desc?: string;
  total_positive?: number;
  total_negative?: number;
  total_reviews?: number;
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

export default GameCalendarData;