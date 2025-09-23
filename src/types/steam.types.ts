/**
 * Steam API 관련 타입 정의 (snake_case 통일)
 * 게임 캘린더 특화 Steam 데이터 구조
 */

// Steam 게임 검색 결과
export interface SteamSearchResult {
  appid: number;
  name: string;
  icon?: string;
  logo?: string;
}

// Steam 게임 검색 응답
export interface SteamSearchResponse {
  results?: SteamSearchResult[];
}

// Steam AppDetails API 응답 구조
export interface SteamAppDetailsResponse {
  [app_id: string]: {
    success: boolean;
    data?: SteamAppData;
  };
}

// Steam 앱 데이터 (appDetails API에서 반환)
export interface SteamAppData {
  type: string; // "game", "dlc", "music", "demo" 등
  name: string;
  steam_appid: number;
  required_age?: number;
  is_free: boolean;
  dlc?: number[]; // DLC 목록 (본편인 경우)
  fullgame?: {
    // DLC인 경우 본편 정보
    appid: string;
    name: string;
  };
  detailed_description?: string;
  about_the_game?: string;
  short_description?: string;
  supported_languages?: string;
  header_image: string;
  website?: string;
  pc_requirements?: any;
  mac_requirements?: any;
  linux_requirements?: any;
  developers?: string[];
  publishers?: string[];
  price_overview?: {
    currency: string;
    initial: number;
    final: number;
    discount_percent: number;
    initial_formatted?: string;
    final_formatted?: string;
  };
  packages?: number[];
  package_groups?: any[];
  platforms?: {
    windows: boolean;
    mac: boolean;
    linux: boolean;
  };
  metacritic?: {
    score: number;
    url: string;
  };
  categories?: Array<{
    id: number;
    description: string;
  }>;
  genres?: Array<{
    id: string;
    description: string;
  }>;
  screenshots?: Array<{
    id: number;
    path_thumbnail: string;
    path_full: string;
  }>;
  movies?: Array<{
    id: number;
    name: string;
    thumbnail: string;
    webm: any;
    mp4: any;
    highlight: boolean;
  }>;
  recommendations?: {
    total: number;
  };
  achievements?: {
    total: number;
    highlighted: any[];
  };
  release_date?: {
    coming_soon: boolean;
    date: string;
  };
  support_info?: {
    url?: string;
    email?: string;
  };
  background?: string;
  content_descriptors?: {
    ids: number[];
    notes?: string;
  };

  // 리뷰 관련 (Steam appDetails에서 제공)
  review_score?: number; // 리뷰 점수
  review_score_desc?: string; // "압도적으로 긍정적", "매우 긍정적" 등
  total_positive?: number; // 긍정적 리뷰 수
  total_negative?: number; // 부정적 리뷰 수
  total_reviews?: number; // 전체 리뷰 수
}

// 게임 캘린더용 Steam 데이터 (snake_case 통일)
export interface GameCalendarSteamData {
  steam_id: number;
  original_name: string; // 원본 영문명
  image: string;
  korea_name?: string; // 한글명 (있는 경우)
  price: string; // "Free" 또는 "₩29,000" 형태
  steam_type: string; // Steam 공식 타입: "game", "dlc", "music", "demo"
  description?: string; // 짧은 설명
  korean_description?: string; // 한글 상세 설명
  developers: string[]; // 개발사
  publishers: string[]; // 배급사
  release_date?: string; // 출시일
  categories: string[]; // Steam 카테고리
  // DLC 관련 정보
  is_full_game: boolean; // 본편 게임 여부
  fullgame_info?: {
    // DLC인 경우 본편 게임 정보
    appid: string;
    name: string;
  };
  dlc_list: number[]; // 본편인 경우 DLC 목록

  // Steam 리뷰 정보 (appDetails에서 바로 추출)
  review_score?: string; // "압도적으로 긍정적" 등
  total_positive?: number; // 긍정적 리뷰 수
  total_negative?: number; // 부정적 리뷰 수
  total_reviews?: number; // 전체 리뷰 수

  // 추가 정보
  screenshots?: string[]; // 스크린샷 URL 목록
  website?: string; // 공식 웹사이트
  is_free: boolean; // 무료 게임 여부
}

// Steam ID 검색 결과
export interface SteamIdSearchResult {
  success: boolean;
  steam_id?: number;
  match_score?: number; // 유사도 점수 (0-1)
  original_query: string;
  found_name?: string;
  search_strategy?: string; // 성공한 검색 전략 정보
}

// Steam API 호출 옵션
export interface SteamApiOptions {
  language?: string; // 기본값: 'korean'
  country_code?: string; // 기본값: 'KR'
  timeout?: number; // 기본값: 10000ms
}

// Steam 서비스 설정
export interface SteamServiceConfig {
  base_url: string;
  search_url: string;
  default_language: string;
  default_country_code: string;
  request_timeout: number;
  retry_attempts: number;
  rate_limit_delay: number;
}

// ===== Steam 리뷰 API 관련 타입들 =====

// Steam 리뷰 API 응답 (store.steampowered.com/appreviews)
export interface SteamReviewsApiResponse {
  success: number; // 1 = 성공, 2 = 실패
  query_summary: {
    num_reviews: number; // 총 리뷰 수
    review_score: number; // 리뷰 점수 (0-9)
    review_score_desc: string; // "압도적으로 긍정적", "매우 긍정적" 등
    total_positive: number; // 긍정적 리뷰 수
    total_negative: number; // 부정적 리뷰 수
    total_reviews: number; // 전체 리뷰 수 (확인용)
  };
  reviews?: Array<{
    recommendationid: string;
    author: any;
    language: string;
    review: string;
    timestamp_created: number;
    timestamp_updated: number;
    voted_up: boolean;
    votes_up: number;
    votes_funny: number;
    weighted_vote_score: string;
    comment_count: number;
    steam_purchase: boolean;
    received_for_free: boolean;
    written_during_early_access: boolean;
  }>;
  cursor?: string;
}

// 간소화된 Steam 리뷰 데이터 (snake_case 통일)
export interface SteamReviewSummary {
  success: boolean;
  num_reviews: number;
  review_score: number; // 0-9
  review_score_desc: string; // "압도적으로 긍정적" 등
  total_positive: number;
  total_negative: number;
  total_reviews: number;
}

// Steam 리뷰 API 옵션
export interface SteamReviewApiOptions {
  /** 언어 필터 (기본값: all) */
  language?: string;
  /** 리뷰 타입 (기본값: all) */
  review_type?: 'all' | 'positive' | 'negative';
  /** 구매자만 (기본값: all) */
  purchase_type?: 'all' | 'steam' | 'non_steam_purchase';
  /** 최대 리뷰 수 (기본값: 0) */
  num_per_page?: number;
  /** 커서 (페이징용) */
  cursor?: string;
}
