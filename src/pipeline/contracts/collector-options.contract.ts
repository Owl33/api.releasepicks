/**
 * Steam 파이프라인 우선순위 선별 시 사용하는 기존 게임 정보 스냅샷
 */
export type ExistingGamesMap = Map<
  number,
  {
    steam_id: number;
    coming_soon?: boolean | null;
    release_date_date?: Date | null;
    followers_cache?: number | null;
    popularity_score?: number | null;
  }
>;

export interface PrioritySelectionOptions {
  limit: number;
  mode: 'bootstrap' | 'operational';
  existingGames?: ExistingGamesMap;
}

export interface SteamCollectOptions {
  mode: 'bootstrap' | 'operational';
  limit: number;
  strategy?: 'latest' | 'priority' | 'new' | 'batch';
}

export interface CollectProcessedDataOptions {
  monthsBack?: number;
  monthsForward?: number;
  limitMonths?: number;
  ordering?: '-released' | '-added';
  metacritic?: string;
}
