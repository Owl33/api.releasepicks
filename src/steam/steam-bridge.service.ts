import { Injectable } from '@nestjs/common';

import { GameStoreLinks } from '../types/domain.types';
import {
  GameCalendarSteamData,
  SteamBridgeOptions,
  SteamBridgeResult,
  SteamBridgeStats,
  SteamIntegrationContext,
} from '../types/steam.types';
import { SteamIdResolver } from './steam-id.resolver';
import { SteamDetailLoader } from './steam-detail.loader';
import { SteamReviewAggregator } from './steam-review.aggregator';

@Injectable()
export class SteamBridge {
  private readonly detailCache = new Map<number, GameCalendarSteamData>();
  private readonly reviewCache = new Map<
    number,
    GameCalendarSteamData['review_summary'] & {
      success?: boolean;
      num_reviews?: number;
    }
  >();

  constructor(
    private readonly resolver: SteamIdResolver,
    private readonly detailLoader: SteamDetailLoader,
    private readonly reviewAggregator: SteamReviewAggregator,
  ) {}

  async enhance(
    context: SteamIntegrationContext,
    options: SteamBridgeOptions,
  ): Promise<SteamBridgeResult> {
    const stats: SteamBridgeStats = {
      resolver_calls: 0,
      appdetails_calls: 0,
      review_calls: 0,
      cache_hits: {
        appdetails: 0,
        reviews: 0,
      },
      failures: [],
    };

    let steamId = context.presetSteamId ?? null;

    if (!steamId) {
      steamId = this.parseSteamIdFromSources(
        context.storeLinks,
        context.presetSteamUrl,
      );
    }

    if (!steamId) {
      const resolution = await this.resolver.resolve(
        context.gameName,
        context.storeLinks,
      );
      stats.resolver_calls = resolution.apiCalls ?? 0;

      if (resolution.success && resolution.steam_id) {
        steamId = resolution.steam_id;
      } else {
        stats.failures.push({
          stage: 'resolver',
          reason: resolution.notes || 'not_found',
        });
        return {
          integrated: false,
          stats,
        };
      }
    }

    if (!steamId) {
      stats.failures.push({ stage: 'resolver', reason: 'steam_id_missing' });
      return {
        integrated: false,
        stats,
      };
    }

    let calendarData = this.detailCache.get(steamId);
    if (calendarData) {
      stats.cache_hits.appdetails += 1;
    } else {
      const appDetails = await this.detailLoader.fetchAppDetails(steamId, {
        timeout: options.timeout,
      });
      stats.appdetails_calls += 1;

      if (!appDetails) {
        stats.failures.push({ stage: 'appdetails', reason: 'no_data' });
        return {
          integrated: false,
          steam_id: steamId,
          stats,
        };
      }

      calendarData = this.detailLoader.convertToCalendarData(appDetails);
      this.detailCache.set(steamId, calendarData);
    }

    const reviewSummaryCache = this.reviewCache.get(steamId);
    if (reviewSummaryCache) {
      stats.cache_hits.reviews += 1;
      if (reviewSummaryCache) {
        calendarData.review_summary = {
          review_score: reviewSummaryCache.review_score,
          review_score_desc: reviewSummaryCache.review_score_desc,
          total_positive: reviewSummaryCache.total_positive,
          total_negative: reviewSummaryCache.total_negative,
          total_reviews: reviewSummaryCache.total_reviews,
        };
      }
    } else {
      const reviewSummary = await this.reviewAggregator.fetchSummary(steamId);
      stats.review_calls += 1;

      if (reviewSummary.success) {
        calendarData.review_summary = {
          review_score: reviewSummary.review_score,
          review_score_desc: reviewSummary.review_score_desc,
          total_positive: reviewSummary.total_positive,
          total_negative: reviewSummary.total_negative,
          total_reviews: reviewSummary.total_reviews,
        };
        this.reviewCache.set(steamId, calendarData.review_summary);
      } else {
        stats.failures.push({ stage: 'reviews', reason: 'not_available' });
      }
    }

    return {
      integrated: true,
      steam_id: steamId,
      data: calendarData,
      stats,
    };
  }

  getCacheStats(): { appdetails: number; reviews: number } {
    return {
      appdetails: this.detailCache.size,
      reviews: this.reviewCache.size,
    };
  }

  clearCaches(): void {
    this.detailCache.clear();
    this.reviewCache.clear();
  }

  private parseSteamIdFromSources(
    storeLinks?: GameStoreLinks,
    presetUrl?: string | null,
  ): number | null {
    return (
      this.resolver.parseSteamIdFromUrl(presetUrl) ??
      this.resolver.parseSteamIdFromUrl(storeLinks?.steam)
    );
  }
}
