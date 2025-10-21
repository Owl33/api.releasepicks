// src/services/rawg/rawg.types.ts
export interface RawgNamedRef {
  id: number;
  slug: string;
  name: string;
}
export interface RawgPlatformRef {
  platform: RawgNamedRef; // { id, slug, name }
}

export interface RawgGameSearchResult {
  id: number;
  slug: string;
  name: string;
  released?: string | null;
  tba?: boolean;
  background_image: string;
  added?: number | null;
  short_screenshots: {
    id: number;
    image: string;
  }[];
  metacritic?: number | null;
  rating?: number | null;
  ratings_count?: number | null;
  platforms?: RawgPlatformRef[];
  parent_platforms?: RawgPlatformRef[];
  genres?: RawgNamedRef[];
  tags?: RawgNamedRef[];

  // ===== Phase 5.5: DLC 감지를 위한 필드 추가 =====
  parent_games_count?: number | null; // DLC 여부 판단 (> 0이면 DLC 가능성)
  parents_count?: number | null;
}
export type RawgGameShort = RawgGameSearchResult;

export interface RawgGameDetails extends RawgGameSearchResult {
  description_raw?: string | null;
  description?: string | null;
  website?: string | null;
  reddit_url?: string | null;
  developers?: string[] | null;
  publishers?: string[] | null;
  stores?: RawgGameStoreResult[] | null;
  reviews_count?: number | null;
}

export interface RawgListResponse<T> {
  results: T[];
  next?: string | null;
  previous?: string | null;
}

export interface RawgGameStoreResult {
  id: number;
  url: string | null;
  url_en?: string | null;
  url_ru?: string | null;
  store_id: number;
  store: RawgNamedRef & {
    domain?: string | null;
  };
}
