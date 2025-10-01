/** 공통 API 응답 형태 (컨트롤러에서 사용) */
export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data: T;
  timestamp: string; // ISO 8601
}

/** YouTube 검색 결과(서비스 내부 전용 최소 필드) */
export interface YouTubeSearchItem {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  publishedAt: string;   // ISO 8601
  channelId: string;
  channelTitle: string;
  durationSec?: number;
  url: string;
}

/** 검색 필터 */
export interface YouTubeSearchFilters {
  /** 최대 결과 수(쿼리당) */
  maxResults?: number; // default 5
  /** 언어(검색 쿼리 가중에만 사용) */
  lang?: string;       // "en" | "ko" | ...
  /** 지역 코드(유튜브 지역 결과 가중) */
  region?: string;     // "US" | "KR" | ...
  /** 공식 채널만 강제 여부 */
  strictOfficial?: boolean; // default false
}

/** 휴리스틱 신뢰도 등급 */
export type ConfidenceLevel = 'low' | 'medium' | 'high';

/** 최종 트레일러 결과 */
export interface GameTrailerResult {
  slug: string;
  queryTried: string[];  // 시도한 쿼리 목록
  picked: {
    videoId: string;
    url: string;
    title: string;
    description: string;
    thumbnailUrl: string;
    publishedAt: string;   // ISO 8601
    channelTitle: string;

    /** 채널/키워드 기반으로 '공식 트레일러'로 판단되는지 */
    isOfficialTrailer: boolean;

    /** 휴리스틱 신뢰도 구간화 */
    confidence: ConfidenceLevel;

    /** 0.0 ~ 1.0 (가중합 스코어) */
    score: number;
  } | null;
}
