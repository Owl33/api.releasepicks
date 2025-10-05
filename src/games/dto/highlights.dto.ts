import { Platform, Store } from '../../entities';
import { StoreLinkDto } from './calendar.dto';

/**
 * 홈 화면 하이라이트 응답 DTO
 */
export interface HighlightGameDto {
  gameId: number;
  name: string;
  slug: string;
  releaseDate: Date | string | number | null;
  popularityScore: number;
  platformsSummary: string[];
  posterImage: string | null;
  daysUntilRelease: number | null;
  platforms: Platform[];
  stores: Store[];
  storeLinks: StoreLinkDto[];
  releaseIds: number[];
  comingSoon: boolean;
}

export interface HighlightsResponseDto {
  generatedAt: string;
  upcoming: HighlightGameDto[];
  popular: HighlightGameDto[];
}
