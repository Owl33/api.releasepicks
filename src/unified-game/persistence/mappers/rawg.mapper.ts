import {
  GameCalendarData,
  RawgGameDetail,
  RawgListGame,
  RawgMediaInfo,
  RawgCollectedGame,
} from '../../../types/game-calendar-unified.types';
import { Game } from '../../../entities/game.entity';
import { GameDetail } from '../../../entities/game-detail.entity';
import { GameStoreLinks } from '../../../types/domain.types';
import { SharedMapper } from './shared.mapper';
import { ReleaseStatus } from '../../../types/domain.types';
import {
  GameDetailEntityPayload,
  GameEntityPayload,
} from '../../../types/persistence.types';

export class RawgMapper {
  static mapRawgGameToBaseData(
    rawgGame: RawgListGame,
    details?: RawgGameDetail | null,
    stores?: RawgCollectedGame['stores'],
    media?: RawgMediaInfo | null,
    steamStoreUrl?: string | null,
    rawgParentIds?: number[] | null,
  ): GameCalendarData {
    const releaseDate = rawgGame.released || null;
    const now = new Date();
    const releaseStatus: ReleaseStatus = releaseDate
      ? new Date(releaseDate) <= now
        ? 'released'
        : 'upcoming'
      : 'upcoming';

    const normalizedPlatforms = SharedMapper.normalizePlatforms(
      rawgGame.platforms || [],
    );
    const platformType =
      SharedMapper.determinePlatformType(normalizedPlatforms);

    const tags = SharedMapper.normalizeRawgTags(rawgGame.tags || []);

    const STORE_ID_MAP: Record<number, string> = {
      1: 'steam',
      2: 'playstation',
      3: 'xbox',
      4: 'epic',
      5: 'gog',
      6: 'nintendo',
    };

    const storeLinks: GameStoreLinks = {};

    (stores || [])
      .filter((store: any) => store?.store?.id && store.url)
      .forEach((store: any) => {
        const mapped = STORE_ID_MAP[store.store.id];
        if (mapped && !storeLinks[mapped]) {
          storeLinks[mapped] = store.url;
        }
      });

    if (steamStoreUrl) {
      storeLinks.steam = steamStoreUrl;
    }

    const parentIds = Array.isArray(rawgParentIds)
      ? rawgParentIds.filter((value) => typeof value === 'number')
      : [];
    const primaryParentId = parentIds.length > 0 ? parentIds[0] : null;
    const dlcContext = parentIds.length > 0 ? { rawg_parent_ids: parentIds } : undefined;

    return {
      rawg_id: rawgGame.id,
      name: rawgGame.name,
      original_name: rawgGame.name,
      slug_name: details?.slugName || rawgGame.slug || null,
      release_date: releaseDate,
      release_status: releaseStatus,
      tba: rawgGame.tba,
      platform_type: platformType,
      platforms: normalizedPlatforms,
      genres: (rawgGame.genres || []).map((g: any) => g?.name).filter(Boolean),
      tags,
      developers: details?.developers || [],
      publishers: details?.publishers || [],
      rating: rawgGame.rating || undefined,
      ratings_count: rawgGame.ratings_count || undefined,
      esrb_rating: rawgGame.esrb_rating?.name || null,
      required_age: null,
      early_access:
        (rawgGame.tags || []).some(
          (tag: any) => tag?.name?.toLowerCase() === 'early access',
        ) || false,
      description: rawgGame.description_raw || undefined,
      korean_description: undefined,
      website: details?.website || null,
      image: rawgGame.background_image || null,
      screenshots: SharedMapper.normalizeScreenshots(
        rawgGame.short_screenshots?.slice(1),
      ),
      trailer_url: media?.youtubeUrl || null,
      store_links: storeLinks,
      price: undefined,
      currency: undefined,
      steam_integrated: false,
      steam_type: undefined,
      korea_name: undefined,
      is_full_game: undefined,
      dlc_list: undefined,
      review_summary: undefined,
      metacritic: null,
      is_dlc: false,
      parent_rawg_id: primaryParentId,
      parent_steam_id: null,
      last_verified_month: null,
      last_synced_source: null,
      added: rawgGame.added,
      added_by_status: rawgGame.added_by_status || {},
      dlc_context: dlcContext,
      categories: [],
      game_type: 'main_game',
      game_type_confidence: 0.8,
      game_type_reason: 'RAWG 기본 분류',
      is_free: rawgGame.is_free || false,
    };
  }

  static mapToGameEntity(gameData: GameCalendarData): GameEntityPayload {
    const releaseDateValue = gameData.release_date
      ? new Date(gameData.release_date)
      : new Date();
    const reviewSummary = gameData.review_summary || {};

    return {
      rawg_id: gameData.rawg_id,
      name: gameData.name,
      released: releaseDateValue,
      platforms: [...(gameData.platforms || [])],
      genres: [...(gameData.genres || [])],
      added: gameData.added ?? 0,
      image: gameData.image ?? undefined,
      developers: [...(gameData.developers || [])],
      publishers: [...(gameData.publishers || [])],
      release_status: gameData.release_status,
      platform_type: gameData.platform_type,
      last_verified_month: gameData.last_verified_month ?? undefined,
      last_synced_source: gameData.last_synced_source ?? undefined,
      steam_id: gameData.steam_id ?? undefined,
      korea_name: gameData.korea_name ?? undefined,
      steam_price: gameData.price ?? undefined,
      steam_type:
        gameData.steam_type ||
        (gameData.is_full_game === false ? 'dlc' : 'game') ||
        undefined,
      fullgame_info:
        gameData.dlc_context?.steam_fullgame_info ?? undefined,
      dlc_list: gameData.dlc_list ?? undefined,
      rawg_parent_ids: gameData.dlc_context?.rawg_parent_ids ?? undefined,
      steam_reviews_positive: reviewSummary.total_positive ?? undefined,
      steam_reviews_total: reviewSummary.total_reviews ?? undefined,
      steam_review_score: reviewSummary.review_score_desc ?? undefined,
    };
  }

  static mapToGameDetailEntity(
    gameData: GameCalendarData,
    gameId: number,
  ): GameDetailEntityPayload {
    return {
      game_id: gameId,
      slug_name: gameData.slug_name || '',
      tags: [...(gameData.tags || [])],
      rating: gameData.rating ?? undefined,
      early_access: gameData.early_access ?? undefined,
      ratings_count: gameData.ratings_count ?? undefined,
      screenshots: SharedMapper.normalizeScreenshots(gameData.screenshots),
      store_links: gameData.store_links || {},
      esrb_rating: gameData.esrb_rating ?? undefined,
      description: gameData.description ?? undefined,
      website: gameData.website ?? undefined,
      korean_description: gameData.korean_description ?? undefined,
      steam_categories: SharedMapper.normalizeSteamCategories(
        gameData.categories || [],
      ),
    };
  }
}
