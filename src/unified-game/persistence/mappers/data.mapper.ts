import {
  GameCalendarData,
  RawgCollectedGame,
  RawgGameDetail,
  RawgListGame,
  RawgMediaInfo,
} from '../../../types/game-calendar-unified.types';
import { GameCalendarSteamData } from '../../../types/steam.types';
import { SteamReviewSummary } from '../../../types/domain.types';
import { Game } from '../../../entities/game.entity';
import { GameDetail } from '../../../entities/game-detail.entity';

import {
  GameDetailEntityPayload,
  GameEntityPayload,
} from '../../../types/persistence.types';

import { RawgMapper } from './rawg.mapper';
import { SteamMapper } from './steam.mapper';
import { SharedMapper } from './shared.mapper';

export class DataMapper {
  static shared = SharedMapper;
  static rawg = RawgMapper;
  static steam = SteamMapper;

  static mapToGameEntity(gameData: GameCalendarData): GameEntityPayload {
    return RawgMapper.mapToGameEntity(gameData);
  }

  static mapToGameDetailEntity(
    gameData: GameCalendarData,
    gameId: number,
  ): GameDetailEntityPayload {
    return RawgMapper.mapToGameDetailEntity(gameData, gameId);
  }

  static mergeWithSteamData(
    baseData: GameCalendarData,
    steamData: GameCalendarSteamData,
    steamReviews?: SteamReviewSummary,
  ): GameCalendarData {
    const data: GameCalendarSteamData = {
      ...steamData,
      review_summary: steamReviews || steamData.review_summary,
    };

    return SteamMapper.mergeWithSteamData(baseData, data);
  }

  static mapFromGameEntity(
    game: Game,
    gameDetail?: GameDetail | null,
  ): GameCalendarData {
    return SteamMapper.mapFromGameEntity(game, gameDetail);
  }

  static mapRawgGameToBaseData(
    rawgGame: RawgListGame,
    details?: RawgGameDetail | null,
    stores?: RawgCollectedGame['stores'],
    media?: RawgMediaInfo | null,
    steamStoreUrl?: string | null,
    rawgParentIds?: number[] | null,
  ): GameCalendarData {
    return RawgMapper.mapRawgGameToBaseData(
      rawgGame,
      details,
      stores,
      media,
      steamStoreUrl,
      rawgParentIds,
    );
  }

  static normalizeScreenshots(values: any): string[] {
    return SharedMapper.normalizeScreenshots(values);
  }

  static normalizeSteamCategories(values: any[]): string[] {
    return SharedMapper.normalizeSteamCategories(values);
  }

  static updateGameEntity(
    existingGame: Game,
    newGameData: GameCalendarData,
  ): void {
    existingGame.name = newGameData.name;
    const releaseDateValue = newGameData.release_date;
    if (releaseDateValue) {
      existingGame.released = new Date(releaseDateValue);
    }
    existingGame.platforms = [...newGameData.platforms];
    existingGame.genres = [...(newGameData.genres || [])];
    existingGame.added = newGameData.added ?? existingGame.added;
    existingGame.image = newGameData.image ?? existingGame.image;
    existingGame.developers = [...(newGameData.developers || [])];
    existingGame.publishers = [...(newGameData.publishers || [])];
    if (newGameData.release_status) {
      existingGame.release_status = newGameData.release_status;
    }
    if (newGameData.platform_type) {
      existingGame.platform_type = newGameData.platform_type;
    }
    if (
      newGameData.last_verified_month !== undefined &&
      newGameData.last_verified_month !== null
    ) {
      existingGame.last_verified_month = newGameData.last_verified_month;
    }
    if (
      newGameData.last_synced_source !== undefined &&
      newGameData.last_synced_source !== null
    ) {
      existingGame.last_synced_source = newGameData.last_synced_source;
    }

    if (newGameData.steam_id !== undefined && newGameData.steam_id !== null) {
      existingGame.steam_id = newGameData.steam_id;
    }
    if (
      newGameData.korea_name !== undefined &&
      newGameData.korea_name !== null
    ) {
      existingGame.korea_name = newGameData.korea_name;
    }
    if (newGameData.price !== undefined && newGameData.price !== null) {
      existingGame.steam_price = newGameData.price;
    }
    if (
      newGameData.steam_type !== undefined &&
      newGameData.steam_type !== null
    ) {
      existingGame.steam_type = newGameData.steam_type;
    }
    if (newGameData.dlc_list) {
      existingGame.dlc_list = [...newGameData.dlc_list];
    }

    if (newGameData.dlc_context) {
      if (
        newGameData.dlc_context.steam_fullgame_info !== undefined &&
        newGameData.dlc_context.steam_fullgame_info !== null
      ) {
        existingGame.fullgame_info =
          newGameData.dlc_context.steam_fullgame_info;
      } else if (
        newGameData.dlc_context.steam_fullgame_info === null ||
        newGameData.dlc_context.steam_fullgame_info === undefined
      ) {
        existingGame.fullgame_info = undefined;
      }

      if (newGameData.dlc_context.rawg_parent_ids !== undefined) {
        const ids = newGameData.dlc_context.rawg_parent_ids;
        existingGame.rawg_parent_ids =
          ids && ids.length > 0 ? [...ids] : undefined;
      }
    }

    const reviewSummary = newGameData.review_summary || {};
    if (reviewSummary.total_positive !== undefined) {
      existingGame.steam_reviews_positive = reviewSummary.total_positive;
    }
    if (reviewSummary.total_reviews !== undefined) {
      existingGame.steam_reviews_total = reviewSummary.total_reviews;
    }
    if (reviewSummary.review_score_desc) {
      existingGame.steam_review_score = reviewSummary.review_score_desc;
    }
  }

  static updateGameDetailEntity(
    gameDetail: GameDetail,
    newGameData: GameCalendarData,
  ): void {
    if (newGameData.slug_name !== undefined && newGameData.slug_name !== null) {
      gameDetail.slug_name = newGameData.slug_name;
    }
    if (newGameData.tags) {
      gameDetail.tags = [...newGameData.tags];
    }
    if (newGameData.rating !== undefined && newGameData.rating !== null) {
      gameDetail.rating = newGameData.rating;
    }
    if (
      newGameData.early_access !== undefined &&
      newGameData.early_access !== null
    ) {
      gameDetail.early_access = newGameData.early_access;
    }
    if (
      newGameData.ratings_count !== undefined &&
      newGameData.ratings_count !== null
    ) {
      gameDetail.ratings_count = newGameData.ratings_count;
    }

    if (
      newGameData.screenshots !== undefined &&
      newGameData.screenshots !== null
    ) {
      gameDetail.screenshots = SharedMapper.normalizeScreenshots(
        newGameData.screenshots,
      );
    }

    if (newGameData.store_links) {
      gameDetail.store_links = { ...newGameData.store_links };
    }

    if (newGameData.esrb_rating !== undefined) {
      gameDetail.esrb_rating = newGameData.esrb_rating || undefined;
    }
    if (newGameData.description !== undefined) {
      gameDetail.description = newGameData.description || undefined;
    }
    if (newGameData.website !== undefined) {
      gameDetail.website = newGameData.website || undefined;
    }
    if (newGameData.korean_description !== undefined) {
      gameDetail.korean_description =
        newGameData.korean_description || undefined;
    }
    if (newGameData.categories) {
      gameDetail.steam_categories = SharedMapper.normalizeSteamCategories(
        newGameData.categories,
      );
    }
  }
}
