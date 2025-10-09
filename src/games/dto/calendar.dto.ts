import { Platform, ReleaseStatus, Store } from '../../entities';

export interface StoreLinkDto {
  store: Store;
  url: string | null;
}

/**
 * 월별 캘린더 응답 DTO
 * 날짜별 중복 플랫폼을 통합한 단일 게임 단위 구조를 전달한다.
 */
export interface CalendarReleaseDto {
  releaseIds: number[];
  gameId: number;
  name: string;
  slug: string;
  platforms: Platform[];
  releaseDate: Date | string | number | null;
  stores: Store[];
  ogName: string;
  storeLinks: StoreLinkDto[];
  comingSoon: boolean;
  releaseDateRaw?: string | null;

  releaseStatus: ReleaseStatus | null;
  popularityScore: number;
  headerImage: string;
  genres: string[];
  developers: string[];
  publishers: string[];
  currentPrice: number | null;
  isFree: boolean;
}

export interface CalendarResponseDto {
  month: string; // YYYY-MM
  range: {
    start: Date | string;
    end: Date | string;
  };
  count: {
    total: number;
    games: number;
    days: number;
  };
  data: CalendarReleaseDto[];
}
