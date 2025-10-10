export type ExistingGamesMap = Map<
  number,
  {
    steam_id: number;
    coming_soon?: boolean | null;
    release_date_date?: Date | string | null;
    followers_cache?: number | null;
    popularity_score?: number | null;
  }
>;
