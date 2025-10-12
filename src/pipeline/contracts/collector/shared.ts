export interface ExistingGameSnapshot {
  steam_id: number;
  game_id?: number;
  rawg_id?: number | null;
  coming_soon?: boolean | null;
  release_date_date?: Date | string | null;
  followers_cache?: number | null;
  popularity_score?: number | null;
}

export type ExistingGamesMap = Map<number, ExistingGameSnapshot>;
