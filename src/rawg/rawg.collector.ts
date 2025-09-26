import { Injectable, Logger } from '@nestjs/common';
import { RawgService } from './rawg.service';
import { YouTubeService } from '../youtube/youtube.service';
import {
  RawgCollectorOptions,
  RawgCollectorResult,
  RawgCollectedGame,
  RawgGameDetail,
  RawgGameStore,
  RawgMediaInfo,
  RawgListGame,
  RawgParentHint,
} from '../types/game-calendar-unified.types';

interface RawgCollectorStats {
  list: number;
  details: number;
  stores: number;
  parents: number;
  trailers: number;
  retries: number;
  failures: number;
}

interface RawgCollectorContext {
  detailCache: Map<number, RawgGameDetail | null>;
  storeCache: Map<number, RawgGameStore[] | null>;
  mediaCache: Map<number, RawgMediaInfo | null>;
  parentCache: Map<number, RawgParentHint[] | null>;
  stats: RawgCollectorStats;
}

@Injectable()
export class RawgCollector {
  private readonly logger = new Logger(RawgCollector.name);

  constructor(
    private readonly rawgService: RawgService,
    private readonly youtubeService: YouTubeService,
  ) {}

  async collectMonthlyGames(
    month: string,
    options: RawgCollectorOptions,
  ): Promise<RawgCollectorResult> {
    const context = this.initializeContext();

    const rawgResponse = await this.rawgService.getMonthlyGames(
      month,
      options.maxGames * 2,
    );
    context.stats.list += rawgResponse.apiCalls ?? 1;

    const filtered = this.applyFilters(rawgResponse.games || [], options);
    const selected = filtered.slice(0, options.maxGames);

    const deliveredGames: RawgCollectedGame[] = [];

    for (const rawgGame of selected) {
      const failures: string[] = [];

      const detail = await this.loadDetails(rawgGame, context).catch(
        (error) => {
          failures.push(`details:${error?.message || 'unknown'}`);
          context.stats.failures += 1;
          return null;
        },
      );

      const parents = await this.loadParents(rawgGame, detail, context).catch(
        (error) => {
          failures.push(`parents:${error?.message || 'unknown'}`);
          context.stats.failures += 1;
          return null;
        },
      );

      const stores = await this.loadStores(rawgGame, context).catch((error) => {
        failures.push(`stores:${error?.message || 'unknown'}`);
        context.stats.failures += 1;
        return [];
      });

      const media = options.enableTrailers
        ? await this.loadMedia(rawgGame, detail, context).catch((error) => {
            failures.push(`trailer:${error?.message || 'unknown'}`);
            context.stats.failures += 1;
            return null;
          })
        : null;

      const { steamStoreId, steamStoreUrl } =
        this.extractSteamStoreInfo(stores);

      deliveredGames.push({
        base: rawgGame,
        detail: detail || undefined,
        stores: stores || undefined,
        media: media || undefined,
        parentHints: parents ?? undefined,
        steamStoreId,
        steamStoreUrl,
        failures: failures.length > 0 ? failures : undefined,
      });
    }

    return {
      month,
      totalCandidates: filtered.length,
      deliveredGames,
      apiCallStats: context.stats,
    };
  }

  private initializeContext(): RawgCollectorContext {
    return {
      detailCache: new Map<number, RawgGameDetail | null>(),
      storeCache: new Map<number, RawgGameStore[] | null>(),
      mediaCache: new Map<number, RawgMediaInfo | null>(),
      parentCache: new Map<number, RawgParentHint[] | null>(),
      stats: {
        list: 0,
        details: 0,
        stores: 0,
        parents: 0,
        trailers: 0,
        retries: 0,
        failures: 0,
      },
    };
  }

  private applyFilters(
    games: RawgListGame[],
    options: RawgCollectorOptions,
  ): RawgListGame[] {
    const uniqueMap = new Map<number, RawgListGame>();

    for (const game of games) {
      if (!game || uniqueMap.has(game.id)) {
        continue;
      }

      const popularity = game.added ?? 0;
      if (popularity < options.minPopularity) {
        continue;
      }

      const isEarlyAccess = this.isEarlyAccess(game);
      if (!options.includeEarlyAccess && isEarlyAccess) {
        continue;
      }

      uniqueMap.set(game.id, game);
    }

    return Array.from(uniqueMap.values());
  }

  private isEarlyAccess(game: RawgListGame): boolean {
    if (!Array.isArray(game.tags)) {
      return false;
    }

    return game.tags.some((tag: any) => {
      const tagName = typeof tag === 'string' ? tag : tag?.name;
      return (tagName || '').toLowerCase() === 'early access';
    });
  }

  private async loadDetails(
    game: RawgListGame,
    context: RawgCollectorContext,
  ): Promise<RawgGameDetail | null> {
    if (context.detailCache.has(game.id)) {
      return context.detailCache.get(game.id) || null;
    }

    context.stats.details += 1;
    const result = await this.rawgService.getDetails(game.id);
    context.detailCache.set(game.id, result || null);
    return result || null;
  }

  private async loadStores(
    game: RawgListGame,
    context: RawgCollectorContext,
  ): Promise<RawgGameStore[] | null> {
    if (context.storeCache.has(game.id)) {
      return context.storeCache.get(game.id) || null;
    }

    context.stats.stores += 1;
    const response = await this.rawgService.getStore(game.id);
    const stores = Array.isArray(response?.results)
      ? (response.results as RawgGameStore[])
      : [];
    context.storeCache.set(game.id, stores);
    return stores;
  }

  private async loadParents(
    game: RawgListGame,
    detail: RawgGameDetail | null,
    context: RawgCollectorContext,
  ): Promise<RawgParentHint[] | null> {
    if (context.parentCache.has(game.id)) {
      const cached = context.parentCache.get(game.id);
      return cached ?? null;
    }

    const parentHint = detail?.parents_count ?? 0;
    if (!parentHint || parentHint <= 0) {
      context.parentCache.set(game.id, null);
      return null;
    }

    context.stats.parents += 1;
    const response = await this.rawgService.getParentGames(game.id);
    const normalized = Array.isArray(response) ? response : [];

    context.parentCache.set(game.id, normalized);
    return normalized;
  }

  private async loadMedia(
    game: RawgListGame,
    detail: RawgGameDetail | null,
    context: RawgCollectorContext,
  ): Promise<RawgMediaInfo | null> {
    if (context.mediaCache.has(game.id)) {
      return context.mediaCache.get(game.id) || null;
    }

    context.stats.trailers += 1;
    const gameName = detail?.slugName || game.name;
    const videoId = await this.youtubeService.getSimpleTrailer(gameName);
    if (!videoId) {
      context.mediaCache.set(game.id, null);
      return null;
    }

    const media: RawgMediaInfo = {
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      previewImage: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    };
    context.mediaCache.set(game.id, media);
    return media;
  }

  private extractSteamStoreInfo(stores?: RawgGameStore[] | null): {
    steamStoreId: number | null;
    steamStoreUrl: string | null;
  } {
    if (!stores || stores.length === 0) {
      return { steamStoreId: null, steamStoreUrl: null };
    }

    for (const store of stores) {
      if (!store?.url) {
        continue;
      }

      const url = store.url;
      if (
        store.store?.slug === 'steam' ||
        /store\.steampowered\.com\/app\//i.test(url)
      ) {
        const match = url.match(/store\.steampowered\.com\/app\/(\d+)/i);
        if (match) {
          return {
            steamStoreId: Number(match[1]),
            steamStoreUrl: url,
          };
        }
      }
    }

    return { steamStoreId: null, steamStoreUrl: null };
  }
}