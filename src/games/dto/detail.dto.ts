import { GameType, ReleaseStatus, Platform, Store } from '../../entities';
import { StoreLinkDto } from './calendar.dto';

export interface GameDetailResponseDto {
  id: number;
  name: string;
  slug: string;
  steamId: number | null;
  rawgId: number | null;
  gameType: GameType;
  isDlc: boolean;
  comingSoon: boolean;
  popularityScore: number;
  platformsSummary: string[];
  releaseDate: Date | string | number | null;
  releaseStatus: ReleaseStatus | null;
  followersCache: number | null;

  // 상세 메타데이터 (기존 details 필드에서 평탄화)
  description: string | null;
  website: string | null;
  genres: string[];
  tags: string[];
  supportLanguages: string[];
  screenshots: string[];
  videoUrl: string | null;
  metacriticScore: number | null;
  opencriticScore: number | null;
  steamReviewDesc: string | null;
  rawgAdded: number | null;
  totalReviews: number | null;
  reviewScoreDesc: string | null;
  detailPlatformType: string | null;

  // 출시 정보 요약 (기존 releases 배열에서 평탄화)
  releaseIds: number[];
  releasePlatforms: Platform[];
  releaseStores: Store[];
  releaseStoreLinks: StoreLinkDto[];
  releaseDates: Array<Date | string | number | null>;
  releaseStatuses: Array<ReleaseStatus | null>;
  releaseComingSoonFlags: boolean[];
  releasePriceCents: Array<number | null>;
  releaseIsFreeFlags: boolean[];
  releaseFollowers: Array<number | null>;
  releaseReviewsTotal: Array<number | null>;
  releaseReviewScoreDescs: Array<string | null>;
}
