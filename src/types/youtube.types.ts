/**
 * YouTube 트레일러 서비스 타입 정의
 * YouTube Data API v3 기반 게임 공식 트레일러 검색
 */

// YouTube 검색 결과 단일 아이템
export interface YouTubeSearchItem {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  publishedAt: string;
  channelId: string;
  channelTitle: string;
  duration?: string;
  viewCount?: number;
  likeCount?: number;
  categoryId?: string;
}

// YouTube 검색 결과 전체
export interface YouTubeSearchResponse {
  gameName: string;
  searchQuery: string;
  totalResults: number;
  items: YouTubeSearchItem[];
  searchDate: string;
  filters: YouTubeSearchFilters;
}

// YouTube 검색 필터
export interface YouTubeSearchFilters {
  gameName: string;
  includeKeywords?: string[]; // ['trailer', 'gameplay', 'official']
  excludeKeywords?: string[]; // ['review', 'reaction', 'walkthrough']
  channelKeywords?: string[]; // ['official', 'playstation', 'xbox']
  maxResults?: number; // 기본값: 10
  publishedAfter?: string; // ISO 8601 형식
  publishedBefore?: string; // ISO 8601 형식
  minDuration?: number; // 초 단위 (최소 영상 길이)
  maxDuration?: number; // 초 단위 (최대 영상 길이)
  sortBy?: 'relevance' | 'date' | 'viewCount' | 'rating';
  safeSearch?: 'none' | 'moderate' | 'strict';
}

// 트레일러 신뢰도 점수 계산 결과
export interface TrailerConfidenceScore {
  videoId: string;
  totalScore: number; // 0-1 사이
  factors: {
    titleMatch: number; // 제목 매칭 점수
    channelCredibility: number; // 채널 신뢰도
    keywords: number; // 키워드 매칭
    duration: number; // 적절한 길이
    viewCount: number; // 조회수 기반 인기도
    publishDate: number; // 게임 출시일과의 근접성
  };
  isOfficialTrailer: boolean;
  confidence: 'high' | 'medium' | 'low';
}

// 게임별 트레일러 결과 (최종 결과)
export interface GameTrailerResult {
  gameName?: string;
  searchDate?: string;
  bestTrailer?: YouTubeSearchItem & { confidenceScore: TrailerConfidenceScore };
  alternativeTrailers?: Array<
    YouTubeSearchItem & { confidenceScore: TrailerConfidenceScore }
  >;
  searchAttempts?: number;
  searchQueries?: string[];
  noTrailerFound?: boolean;
  errorMessage?: string;
}

// YouTube API 설정
export interface YouTubeApiConfig {
  apiKey: string;
  baseUrl: string;
  quotaLimit: number; // 일일 할당량
  quotaUsed: number; // 사용된 할당량
  cacheTTL: number; // 캐시 만료 시간 (ms)
  retryCount: number;
  timeout: number; // ms
}

// 검색 쿼리 생성 옵션
export interface QueryGenerationOptions {
  gameName: string;
  includeOfficialKeywords?: boolean; // 'official trailer' 포함 여부
  includePlatformKeywords?: boolean; // 'ps5', 'xbox', 'pc' 포함 여부
  includeYearHint?: boolean; // 출시 연도 힌트 포함 여부
  gameReleaseYear?: number;
  platforms?: string[];
}

// YouTube 서비스 통계
export interface YouTubeServiceStats {
  totalSearches: number;
  successfulFinds: number;
  quotaUsage: number;
  averageConfidence: number;
  cacheHitRate: number;
  topChannels: Array<{
    channelTitle: string;
    successfulTrailers: number;
  }>;
  popularKeywords: Array<{
    keyword: string;
    frequency: number;
  }>;
}
