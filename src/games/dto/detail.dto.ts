import { GameType, ReleaseStatus, Platform, Store } from '../../entities';

export interface ReleaseInfo {
  platform: Platform;
  store: Store;
  url: string | null;
  releaseDate: Date | string | number | null;
  releaseDateRaw: string | null;
}

export interface DlcInfo {
  name: string;
  releaseDate: Date | string | number | null;
}
export type CompanyBrief = { id: number; name: string };

export interface GameDetailResponseDto {
  id: number;
  name: string;
  slug: string;
  ogName: string;
  steamId: number | null;
  rawgId: number | null;
  gameType: GameType;
  comingSoon: boolean;
  popularityScore: number;
  releaseDate: Date | string | number | null;
  releaseStatus: ReleaseStatus | null;
  followersCache: number | null;

  // 상세 메타데이터 (기존 details 필드에서 평탄화)
  description: string | null;
  website: string | null;
  genres: string[];
  tags: string[];
  supportLanguages: string[];

  headerImage: string;
  screenshots: string[];
  videoUrl: string | null;
  metacriticScore: number | null;
  opencriticScore: number | null;
  rawgAdded: number | null;
  totalReviews: number | null;
  reviewScoreDesc: string | null;

  // 가격 정보 (releases에서 추출)
  currentPrice: number | null;
  isFree: boolean;
  // 플랫폼 정보 (releases에서 추출한 중복 제거 목록)
  platforms: Platform[];

  // 출시 정보 요약 (각 스토어별 릴리즈 정보)
  // release 테이블은 각 플랫폼별 릴리즈 날짜, store, store_link를 제공
  releases: ReleaseInfo[];

  // DLC 리스트 (본편 게임인 경우에만 존재, 항상 배열로 반환)
  dlcs: DlcInfo[];

  developers: CompanyBrief[];
  publishers: CompanyBrief[];
}
