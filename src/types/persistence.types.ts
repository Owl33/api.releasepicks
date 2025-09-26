import {
  GameStoreLinks,
  GameTypeValue,
  PlatformType,
  ReleaseStatus,
} from './domain.types';

export interface GameEntityPayload {
  rawg_id: number;
  name: string;
  released: Date;
  platforms: string[];
  genres: string[];
  added: number;
  image?: string | undefined;
  developers: string[];
  publishers: string[];
  release_status: ReleaseStatus;
  platform_type: PlatformType;
  last_verified_month?: string | undefined;
  last_synced_source?: string | undefined;
  steam_id?: number | undefined;
  korea_name?: string | undefined;
  steam_price?: string | undefined;
  steam_type?: string | undefined;
  fullgame_info?: Record<string, unknown> | undefined;
  dlc_list?: number[] | undefined;
  rawg_parent_ids?: number[] | undefined;
  steam_reviews_positive?: number | undefined;
  steam_reviews_total?: number | undefined;
  steam_review_score?: string | undefined;
}

export interface GameDetailEntityPayload {
  game_id: number;
  slug_name: string;
  tags: string[];
  rating?: number | undefined;
  early_access?: boolean | undefined;
  ratings_count?: number | undefined;
  screenshots: string[];
  store_links: GameStoreLinks | Record<string, unknown>;
  esrb_rating?: string | undefined;
  description?: string | undefined;
  website?: string | undefined;
  korean_description?: string | undefined;
  steam_categories: string[];
}

export interface GamePersistenceSnapshot extends Record<string, unknown> {
  name: string;
  release_date: string | null;
  platforms: string[];
  genres: string[];
  developers: string[];
  publishers: string[];
  added: number;
  image: string | null;
  release_status: ReleaseStatus;
  platform_type: PlatformType;
  last_verified_month: string | null;
  last_synced_source: string | null;
  steam_id: number | null;
  korea_name: string | null;
  price: string | null;
  steam_type: string | null;
  dlc_list: number[];
  rawg_parent_ids: number[];
  steam_reviews_positive: number | null;
  steam_reviews_total: number | null;
  steam_review_score: string | null;
}

export interface GameDetailPersistenceSnapshot extends Record<string, unknown> {
  slug_name: string | null;
  tags: string[];
  rating: number | null;
  early_access: boolean;
  ratings_count: number | null;
  screenshots: string[];
  store_links: Record<string, unknown>;
  esrb_rating: string | null;
  description: string | null;
  website: string | null;
  korean_description: string | null;
  steam_categories: string[];
}

export interface GameUpdateDiff {
  changedPaths: string[];
  created: string[];
  removed: string[];
}

export interface GameUpdateEvaluation {
  gameDiff: GameUpdateDiff;
  detailDiff: GameUpdateDiff;
  shouldUpdateGame: boolean;
  shouldUpdateDetail: boolean;
}

export interface DlcRelationClassification {
  type: GameTypeValue;
  confidence: number;
  reason: string;
}

export interface DlcRelationPlan {
  rawgId: number;
  steamId?: number | null;
  parentRawgId?: number | null;
  parentSteamId?: number | null;
  classification?: DlcRelationClassification;
}
