import { Injectable } from '@nestjs/common';

import { GameStoreLinks } from '../types/domain.types';
import {
  GameCalendarSteamData,
  SteamApiOptions,
  SteamBridgeOptions,
  SteamBridgeResult,
  SteamIdSearchResult,
  SteamReviewApiOptions,
  SteamReviewSummaryResult,
  SteamIntegrationContext,
} from '../types/steam.types';
import { SteamIdResolver } from './steam-id.resolver';
import { SteamDetailLoader } from './steam-detail.loader';
import { SteamReviewAggregator } from './steam-review.aggregator';
import { SteamBridge } from './steam-bridge.service';

@Injectable()
export class StreamlinedSteamService {
  constructor(
    private readonly resolver: SteamIdResolver,
    private readonly detailLoader: SteamDetailLoader,
    private readonly reviewAggregator: SteamReviewAggregator,
    private readonly steamBridge: SteamBridge,
  ) {}

  async findSteamId(
    gameName: string,
    storeLinks?: Pick<GameStoreLinks, 'steam'>,
    searchStrategies?: string[],
  ): Promise<SteamIdSearchResult> {
    const resolution = await this.resolver.resolve(
      gameName,
      storeLinks,
      searchStrategies,
    );

    if (resolution.success && resolution.steam_id) {
      return {
        success: true,
        steam_id: resolution.steam_id,
        match_score: resolution.confidence ?? 1,
        original_query: gameName,
        found_name: resolution.notes,
        search_strategy: resolution.strategy,
      };
    }

    return {
      success: false,
      original_query: gameName,
    };
  }

  async getGameCalendarData(
    steamId: number,
    options?: SteamApiOptions,
  ): Promise<GameCalendarSteamData | null> {
    const appDetails = await this.detailLoader.fetchAppDetails(
      steamId,
      options,
    );
    if (!appDetails) {
      return null;
    }
    return this.detailLoader.convertToCalendarData(appDetails);
  }

  async getSteamReviews(
    steamId: number,
    options: SteamReviewApiOptions = {},
  ): Promise<SteamReviewSummaryResult> {
    return this.reviewAggregator.fetchSummary(steamId, options);
  }

  async enhanceWithBridge(
    context: SteamIntegrationContext,
    options: SteamBridgeOptions,
  ): Promise<SteamBridgeResult> {
    return this.steamBridge.enhance(context, options);
  }

  async checkSteamApiHealth(): Promise<{
    status: 'ok';
    cache: { appdetails: number; reviews: number };
    timestamp: string;
  }> {
    const cacheStats = this.steamBridge.getCacheStats();

    return {
      status: 'ok',
      cache: cacheStats,
      timestamp: new Date().toISOString(),
    };
  }

  clearCaches(): void {
    this.steamBridge.clearCaches();
  }
}
