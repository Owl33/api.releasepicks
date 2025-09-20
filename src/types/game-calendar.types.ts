/**
 * 게임 캘린더 통합 타입 정의
 * RAWG API 기반 게임 데이터 + 스토어 링크 + YouTube 트레일러
 */

// 기본 게임 정보 (RAWG API 기반)
export interface RawgGameData {
  rawgId: number;
  name: string;
  released: string | null;
  tba: boolean;
  platforms: string[];
  stores: string[];
  genres: string[];
  tags: Array<{ id: number; name: string; slug: string; language: string }>;
  image: string;
  added: number;
  added_by_status: {
    yet: number;
    owned: number;
    beaten: number;
    toplay: number;
    dropped: number;
    playing: number;
  };
  screenshots: string[];
  esrbRating: string | null;
  rating: number;
  ratingsCount: number;

}

// 스토어 URL 매핑 정보
export interface StoreLinks {
  steam?: string;
  playstation?: string;
  epic?: string;
  xbox?: string;
  nintendo?: string;
  gog?: string;
}

// YouTube 트레일러 정보
export interface YouTubeTrailer {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  publishedAt: string;
  channelTitle: string;
}

// 완성된 게임 캘린더 데이터 (프론트엔드용)
export interface GameCalendarItem extends RawgGameData {
  // 기본 게임 정보
  video?: string;
  early_access: boolean;
}

// 월별 캘린더 응답 데이터
export interface MonthlyCalendarResponse {
  month: string; // "2025-01" 형식
  totalGames: number;
  games: GameCalendarItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
  };
  filters: {
    minPopularity: number;
    platforms: string[];
    genres: string[];
  };
}

// 게임 상세 정보 (단일 게임용)
export interface GameDetailResponse extends GameCalendarItem {
  // 추가 상세 정보
  description: string;
  developers: string[];
  publishers: string[];
  website: string | null;
  metacriticScore: number | null;
  averagePlaytime: number; // 시간 단위

  // 관련 게임 추천
  similarGames?: Array<{
    id: number;
    name: string;
    image: string;
    releaseDate: string;
  }>;
}

// 필터링 옵션
export interface CalendarFilters {
  month: string; // "2025-01" 형식
  platforms?: string[];
  genres?: string[];
  minPopularity?: number;
  onlyWithTrailers?: boolean;
  sortBy?: 'releaseDate' | 'popularity' | 'name';
  sortOrder?: 'asc' | 'desc';
}

// API 응답 공통 형식
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
  timestamp: string;
}
