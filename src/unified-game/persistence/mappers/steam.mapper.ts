import {
  GameCalendarData,
  RawgCollectedGame,
} from '../../../types/game-calendar-unified.types';
import { GameCalendarSteamData } from '../../../types/steam.types';
import { Game } from '../../../entities/game.entity';
import { GameDetail } from '../../../entities/game-detail.entity';
import {
  ReleaseStatus,
  PlatformType,
  SteamReviewSummary,
} from '../../../types/domain.types';

import { SharedMapper } from './shared.mapper';

export class SteamMapper {
  static normalizeScreenshots(screenshots: any): string[] {
    return SharedMapper.normalizeScreenshots(screenshots);
  }

  static mergeWithSteamData(
    baseData: GameCalendarData,
    steamData: GameCalendarSteamData,
  ): GameCalendarData {
    const reviewSummary = steamData.review_summary;

    return {
      ...baseData,
      required_age:
        steamData.required_age !== undefined && steamData.required_age !== null
          ? String(steamData.required_age)
          : baseData.required_age,
      image: steamData.image || baseData.image,
      screenshots: steamData.screenshots?.length
        ? SharedMapper.normalizeScreenshots(steamData.screenshots)
        : baseData.screenshots,
      website: steamData.website || baseData.website,
      developers: steamData.developers?.length
        ? steamData.developers
        : baseData.developers,
      publishers: steamData.publishers?.length
        ? steamData.publishers
        : baseData.publishers,
      metacritic: steamData.metacritic || baseData.metacritic || null,
      categories: SharedMapper.normalizeSteamCategories(
        steamData.categories || [],
      ),
      store_links: {
        ...(baseData.store_links || {}),
        steam: steamData.store_url || baseData.store_links?.steam || undefined,
      },
      review_summary: reviewSummary || baseData.review_summary,
      steam_id: steamData.steam_id,
      original_name: steamData.original_name || baseData.original_name,
      korea_name: steamData.korea_name || baseData.korea_name,
      steam_type: steamData.steam_type || baseData.steam_type,
      price: steamData.price || baseData.price,
      currency: steamData.currency || baseData.currency,
      is_full_game:
        steamData.is_full_game !== undefined
          ? steamData.is_full_game
          : baseData.is_full_game,
      dlc_list:
        steamData.dlc_list && steamData.dlc_list.length > 0
          ? SharedMapper.normalizeNumberArray(steamData.dlc_list)
          : baseData.dlc_list,
      is_free:
        steamData.is_free !== undefined ? steamData.is_free : baseData.is_free,
      is_dlc: steamData.steam_type === 'dlc' || baseData.is_dlc,
      game_type: steamData.steam_type === 'dlc' ? 'dlc' : baseData.game_type,
      game_type_confidence: steamData.steam_type
        ? 0.95
        : baseData.game_type_confidence,
      game_type_reason: 'Steam appDetails 기반 재분류',
      parent_steam_id: steamData.parent_appid || baseData.parent_steam_id,
      dlc_context: {
        ...(baseData.dlc_context || {}),
        steam_fullgame_info:
          steamData.fullgame_info || baseData.dlc_context?.steam_fullgame_info,
      },
      steam_integrated: true,
    };
  }

  static mapFromGameEntity(
    game: Game,
    gameDetail?: GameDetail | null,
  ): GameCalendarData {
    const releaseDate = game.released
      ? game.released.toISOString().split('T')[0]
      : null;
    const now = new Date();
    const computedStatus: ReleaseStatus = releaseDate
      ? new Date(releaseDate) <= now
        ? 'released'
        : 'upcoming'
      : 'upcoming';
    const storedStatus =
      (game.release_status as ReleaseStatus) || computedStatus;
    const platformType =
      (game.platform_type as PlatformType) ||
      this.determinePlatformType(
        SharedMapper.normalizeStringArray(game.platforms || []),
      );

    const reviewSummary: SteamReviewSummary = {
      review_score_desc: game.steam_review_score || undefined,
      total_positive: game.steam_reviews_positive || undefined,
      total_reviews: game.steam_reviews_total || undefined,
      total_negative:
        game.steam_reviews_total && game.steam_reviews_positive
          ? game.steam_reviews_total - game.steam_reviews_positive
          : undefined,
    };

    const rawgParentIds = SharedMapper.normalizeNumberArray(
      game.rawg_parent_ids || [],
    );

    const steamFullgameInfo = SharedMapper.normalizeSteamFullgameInfo(
      game.fullgame_info,
    );

    const dlcContext = (() => {
      const hasSteam = !!steamFullgameInfo;
      const hasRawgParents = rawgParentIds.length > 0;

      if (!hasSteam && !hasRawgParents) {
        return undefined;
      }

      return {
        ...(hasRawgParents ? { rawg_parent_ids: rawgParentIds } : {}),
        ...(hasSteam ? { steam_fullgame_info: steamFullgameInfo } : {}),
      };
    })();

    return {
      rawg_id: game.rawg_id,
      steam_id: game.steam_id || null,
      name: game.name,
      original_name: game.name,
      slug_name: gameDetail?.slug_name || null,
      release_date: releaseDate,
      release_status: storedStatus,
      tba: false,
      platform_type: platformType,
      platforms: SharedMapper.normalizePlatforms(game.platforms || []),
      genres: SharedMapper.normalizeStringArray(game.genres || []),
      tags: SharedMapper.normalizeStringArray(gameDetail?.tags || []),
      developers: SharedMapper.normalizeStringArray(game.developers || []),
      publishers: SharedMapper.normalizeStringArray(game.publishers || []),
      rating: gameDetail?.rating || undefined,
      ratings_count: gameDetail?.ratings_count || undefined,
      esrb_rating: gameDetail?.esrb_rating || null,
      required_age: null,
      early_access: gameDetail?.early_access || false,
      description: gameDetail?.description || undefined,
      korean_description: gameDetail?.korean_description || undefined,
      website: gameDetail?.website || null,
      image: game.image || null,
      screenshots: SharedMapper.normalizeScreenshots(gameDetail?.screenshots),
      trailer_url: null,
      store_links: SharedMapper.normalizeObject(gameDetail?.store_links || {}),
      price: game.steam_price || undefined,
      currency: undefined,
      steam_integrated: !!game.steam_id,
      steam_type: game.steam_type || undefined,
      korea_name: game.korea_name || undefined,
      is_full_game: game.steam_type === 'game',
      dlc_list: SharedMapper.normalizeNumberArray(game.dlc_list || []),
      review_summary: reviewSummary,
      metacritic: null,
      categories: SharedMapper.normalizeStringArray(
        gameDetail?.steam_categories || [],
      ),
      is_dlc: game.steam_type === 'dlc' || !!game.parent_game_id,
      parent_rawg_id: game.parent?.rawg_id || null,
      parent_steam_id: game.parent_steam_game_id || null,
      last_verified_month: game.last_verified_month || null,
      last_synced_source: game.last_synced_source || null,
      added: game.added || 0,
      added_by_status: {},
      dlc_context: dlcContext,
      game_type: game.steam_type === 'dlc' ? 'dlc' : 'main_game',
      game_type_confidence: game.steam_type ? 0.95 : 0.5,
      game_type_reason: 'DB 스냅샷 기반 초기화',
      is_free: game.steam_price === '무료',
    };
  }

  private static determinePlatformType(platforms: string[]): PlatformType {
    return SharedMapper.determinePlatformType(platforms);
  }
}
