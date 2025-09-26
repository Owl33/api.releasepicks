import { Injectable } from '@nestjs/common';

import { Game } from '../../entities/game.entity';
import { GameDetail } from '../../entities/game-detail.entity';
import { GameCalendarData } from '../../types/game-calendar-unified.types';
import { PlatformType, ReleaseStatus } from '../../types/domain.types';
import { SharedMapper } from './mappers/shared.mapper';
import {
  GameDetailPersistenceSnapshot,
  GamePersistenceSnapshot,
  GameUpdateDiff,
  GameUpdateEvaluation,
} from '../../types/persistence.types';

@Injectable()
export class GameUpdateEvaluator {
  evaluate(
    existingGame: Game,
    existingDetail: GameDetail | null | undefined,
    incoming: GameCalendarData,
  ): GameUpdateEvaluation {
    const currentGame = this.buildGameSnapshot(existingGame);
    const expectedGame = this.applyGameUpdateRules(currentGame, incoming);

    const gameChanged = this.extractDifferences(
      currentGame,
      expectedGame,
      'game',
    );
    const gameDiff: GameUpdateDiff = {
      changedPaths: gameChanged,
      created: [],
      removed: [],
    };

    const currentDetail = existingDetail
      ? this.buildDetailSnapshot(existingDetail)
      : null;
    const expectedDetail = this.applyDetailUpdateRules(currentDetail, incoming);
    const detailChanged = this.extractDifferences(
      currentDetail ?? this.createEmptyDetailSnapshot(),
      expectedDetail,
      'detail',
    );

    const detailMissing = !existingDetail;
    const shouldCreateDetail = detailMissing && this.hasDetailPayload(incoming);
    const createdDetail = shouldCreateDetail ? ['detail'] : [];

    const detailDiff: GameUpdateDiff = {
      changedPaths: detailChanged,
      created: createdDetail,
      removed: [],
    };

    return {
      gameDiff,
      detailDiff,
      shouldUpdateGame: gameDiff.changedPaths.length > 0,
      shouldUpdateDetail:
        detailDiff.created.length > 0 || detailDiff.changedPaths.length > 0,
    };
  }

  private buildGameSnapshot(game: Game): GamePersistenceSnapshot {
    const releaseStatus = (game.release_status as ReleaseStatus) || 'upcoming';
    const platformType = (game.platform_type as PlatformType) || 'pc';

    return {
      name: game.name,
      release_date: game.released
        ? game.released.toISOString().split('T')[0]
        : null,
      platforms: this.normalizeStringArray(game.platforms),
      genres: this.normalizeStringArray(game.genres),
      developers: this.normalizeStringArray(game.developers),
      publishers: this.normalizeStringArray(game.publishers),
      added: game.added ?? 0,
      image: game.image ?? null,
      release_status: releaseStatus,
      platform_type: platformType,
      last_verified_month: game.last_verified_month ?? null,
      last_synced_source: game.last_synced_source ?? null,
      steam_id: game.steam_id ?? null,
      korea_name: game.korea_name ?? null,
      price: game.steam_price ?? null,
      steam_type: game.steam_type ?? null,
      dlc_list: this.normalizeNumberArray(game.dlc_list),
      rawg_parent_ids: this.normalizeNumberArray(game.rawg_parent_ids),
      steam_reviews_positive: game.steam_reviews_positive ?? null,
      steam_reviews_total: game.steam_reviews_total ?? null,
      steam_review_score: game.steam_review_score ?? null,
    };
  }

  private buildDetailSnapshot(
    detail: GameDetail,
  ): GameDetailPersistenceSnapshot {
    const storeLinksSource: Record<string, unknown> =
      (detail.store_links as Record<string, unknown> | undefined) ?? {};

    return {
      slug_name: detail.slug_name ?? null,
      tags: this.normalizeStringArray(detail.tags),
      rating: detail.rating ?? null,
      early_access: detail.early_access ?? false,
      ratings_count: detail.ratings_count ?? null,
      screenshots: this.normalizeStringArray(detail.screenshots),
      store_links: this.normalizeObject(storeLinksSource),
      esrb_rating: detail.esrb_rating ?? null,
      description: detail.description ?? null,
      website: detail.website ?? null,
      korean_description: detail.korean_description ?? null,
      steam_categories: this.normalizeStringArray(detail.steam_categories),
    };
  }

  private createEmptyDetailSnapshot(): GameDetailPersistenceSnapshot {
    const emptyStoreLinks: Record<string, unknown> = {};
    return {
      slug_name: null,
      tags: [] as string[],
      rating: null,
      early_access: false,
      ratings_count: null,
      screenshots: [] as string[],
      store_links: emptyStoreLinks,
      esrb_rating: null,
      description: null,
      website: null,
      korean_description: null,
      steam_categories: [] as string[],
    };
  }

  private applyGameUpdateRules(
    snapshot: GamePersistenceSnapshot,
    incoming: GameCalendarData,
  ): GamePersistenceSnapshot {
    const next: GamePersistenceSnapshot = {
      ...snapshot,
      platforms: [...snapshot.platforms],
      genres: [...snapshot.genres],
      developers: [...snapshot.developers],
      publishers: [...snapshot.publishers],
      dlc_list: [...snapshot.dlc_list],
      rawg_parent_ids: [...snapshot.rawg_parent_ids],
    };

    if (incoming.name) next.name = incoming.name;
    if (incoming.release_date) next.release_date = incoming.release_date;
    if (incoming.platforms)
      next.platforms = this.normalizeStringArray(incoming.platforms);
    if (incoming.genres)
      next.genres = this.normalizeStringArray(incoming.genres);
    if (incoming.developers)
      next.developers = this.normalizeStringArray(incoming.developers);
    if (incoming.publishers)
      next.publishers = this.normalizeStringArray(incoming.publishers);

    if (incoming.added !== undefined && incoming.added !== null) {
      next.added = incoming.added;
    }

    if (incoming.image !== undefined && incoming.image !== null) {
      next.image = incoming.image;
    }

    if (incoming.release_status) {
      next.release_status = incoming.release_status;
    }
    if (incoming.platform_type) {
      next.platform_type = incoming.platform_type;
    }

    if (
      incoming.last_verified_month !== undefined &&
      incoming.last_verified_month !== null
    ) {
      next.last_verified_month = incoming.last_verified_month;
    }
    if (
      incoming.last_synced_source !== undefined &&
      incoming.last_synced_source !== null
    ) {
      next.last_synced_source = incoming.last_synced_source;
    }

    if (incoming.steam_id !== undefined && incoming.steam_id !== null) {
      next.steam_id = incoming.steam_id;
    }
    if (incoming.korea_name !== undefined && incoming.korea_name !== null) {
      next.korea_name = incoming.korea_name;
    }
    if (incoming.price !== undefined && incoming.price !== null) {
      next.price = incoming.price;
    }
    if (incoming.steam_type !== undefined && incoming.steam_type !== null) {
      next.steam_type = incoming.steam_type;
    }
    if (incoming.dlc_list) {
      next.dlc_list = this.normalizeNumberArray(incoming.dlc_list);
    }
    if (incoming.dlc_context?.rawg_parent_ids !== undefined) {
      next.rawg_parent_ids = this.normalizeNumberArray(
        incoming.dlc_context.rawg_parent_ids,
      );
    }

    const reviewSummary = incoming.review_summary;
    if (reviewSummary?.total_positive) {
      next.steam_reviews_positive = reviewSummary.total_positive;
    }
    if (reviewSummary?.total_reviews) {
      next.steam_reviews_total = reviewSummary.total_reviews;
    }
    if (reviewSummary?.review_score_desc) {
      next.steam_review_score = reviewSummary.review_score_desc;
    }

    return next;
  }

  private applyDetailUpdateRules(
    snapshot: GameDetailPersistenceSnapshot | null,
    incoming: GameCalendarData,
  ): GameDetailPersistenceSnapshot {
    const base = snapshot ?? this.createEmptyDetailSnapshot();
    const next: GameDetailPersistenceSnapshot = {
      ...base,
      tags: [...base.tags],
      screenshots: [...base.screenshots],
      store_links: { ...base.store_links },
      steam_categories: [...base.steam_categories],
    };

    if (incoming.slug_name) {
      next.slug_name = incoming.slug_name;
    }

    if (incoming.tags) {
      next.tags = this.normalizeStringArray(incoming.tags);
    }

    if (incoming.rating) {
      next.rating = incoming.rating;
    }

    if (incoming.early_access !== undefined && incoming.early_access !== null) {
      next.early_access = incoming.early_access;
    }

    if (incoming.ratings_count) {
      next.ratings_count = incoming.ratings_count;
    }

    const normalizedScreenshots = SharedMapper.normalizeScreenshots(
      incoming.screenshots,
    );
    if (incoming.screenshots !== undefined && incoming.screenshots !== null) {
      next.screenshots = this.normalizeStringArray(normalizedScreenshots);
    }

    if (incoming.store_links) {
      next.store_links = this.normalizeObject(incoming.store_links);
    }

    if (incoming.esrb_rating) {
      next.esrb_rating = incoming.esrb_rating;
    }

    if (incoming.description) {
      next.description = incoming.description;
    }

    if (incoming.website) {
      next.website = incoming.website;
    }

    if (incoming.korean_description) {
      next.korean_description = incoming.korean_description;
    }

    if (incoming.categories) {
      next.steam_categories = this.normalizeStringArray(incoming.categories);
    }

    return next;
  }

  private extractDifferences(
    current: Record<string, unknown>,
    next: Record<string, unknown>,
    prefix: string,
  ): string[] {
    const changes: string[] = [];

    for (const key of Object.keys(next)) {
      const currentValue = current[key];
      const nextValue = next[key];

      if (!this.deepEqual(currentValue, nextValue)) {
        changes.push(`${prefix}.${key}`);
      }
    }

    return changes;
  }

  private hasDetailPayload(incoming: GameCalendarData): boolean {
    return (
      !!incoming.slug_name ||
      !!incoming.tags?.length ||
      !!incoming.rating ||
      incoming.early_access !== undefined ||
      !!incoming.ratings_count ||
      !!incoming.screenshots?.length ||
      (!!incoming.store_links &&
        Object.keys(incoming.store_links).length > 0) ||
      !!incoming.esrb_rating ||
      !!incoming.description ||
      !!incoming.website ||
      !!incoming.korean_description ||
      !!incoming.categories?.length
    );
  }

  private normalizeStringArray(values: unknown): string[] {
    if (!Array.isArray(values)) {
      return [];
    }
    const normalized = (values as unknown[]).map((value) => String(value));
    return normalized.sort((a, b) => a.localeCompare(b));
  }

  private normalizeNumberArray(values: unknown): number[] {
    if (!Array.isArray(values)) {
      return [];
    }
    const normalized = (values as unknown[])
      .map((value) => Number(value))
      .filter((value): value is number => Number.isFinite(value));
    return normalized.sort((a, b) => a - b);
  }

  private normalizeObject(obj: unknown): Record<string, unknown> {
    if (!obj || typeof obj !== 'object') {
      return {};
    }

    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b));

    return entries.reduce<Record<string, unknown>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((value, index) => this.deepEqual(value, b[index]));
    }

    if (a && typeof a === 'object' && b && typeof b === 'object') {
      const keysA = Object.keys(a as Record<string, unknown>).sort();
      const keysB = Object.keys(b as Record<string, unknown>).sort();
      if (keysA.length !== keysB.length) return false;
      return keysA.every((key, index) => {
        if (key !== keysB[index]) return false;
        return this.deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        );
      });
    }

    return a === b;
  }
}
