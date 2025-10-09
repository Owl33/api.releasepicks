import { Platform, Store } from '../../entities';
import { StoreLinkDto } from './calendar.dto';

/**
 * 홈 화면 하이라이트 응답 DTO
 */
export interface HighlightGameDto {
  gameId: number;
  name: string;
  slug: string;
  platforms: Platform[];
  releaseDate: Date | string | number | null;
  popularityScore: number;
  headerImage: string ;
  daysUntilRelease: number | null;
  stores: Store[];
  storeLinks: StoreLinkDto[];
  releaseIds: number[];
  comingSoon: boolean;
  releaseDateRaw?: string | null;
  currentPrice: number | null;
  isFree: boolean;
}

export interface HighlightsResponseDto {
  generatedAt: string;
  upcoming: HighlightGameDto[];
  popular: HighlightGameDto[];
}
