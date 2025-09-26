import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import slugify from 'slugify';

import { ErrorHandlerUtil } from '../common/utils/error-handler.util';
import { STEAM_API } from '../common/constants/api.constants';
import { GameStoreLinks } from '../types/domain.types';
import { SteamIdResolutionResult } from '../types/steam.types';

@Injectable()
export class SteamIdResolver {
  private readonly logger = new Logger(SteamIdResolver.name);

  private steamAppListCache: { appid: number; name: string }[] | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1시간

  async resolve(
    gameName: string,
    storeLinks?: GameStoreLinks,
    searchStrategies?: string[],
  ): Promise<SteamIdResolutionResult> {
    const attempts: SteamIdResolutionResult['attempts'] = [];
    let apiCalls = 0;

    const directId = this.extractSteamAppIdFromUrl(storeLinks?.steam);
    if (directId) {
      attempts.push({ query: 'store_link', matched: true });
      return {
        success: true,
        steam_id: directId,
        strategy: 'store_link',
        confidence: 1,
        attempts,
        apiCalls,
      };
    }
    attempts.push({ query: 'store_link', matched: false });

    const appList = await this.getSteamAppList();
    apiCalls += 1;
    if (!appList || appList.length === 0) {
      return {
        success: false,
        attempts,
        notes: 'Steam app list unavailable',
      };
    }

    const searchNames = this.buildSearchNames(gameName, searchStrategies);

    for (const [index, searchName] of searchNames.entries()) {
      const filteredApps = this.filterAppsByName(searchName, appList);
      if (filteredApps.length === 0) {
        attempts.push({ query: searchName, matched: false });
        continue;
      }

      const bestMatch = this.findBestAppMatchOptimized(
        searchName,
        filteredApps,
      );
      if (bestMatch) {
        attempts.push({ query: searchName, matched: true });
        return {
          success: true,
          steam_id: bestMatch.appid,
          strategy: `strategy_${index + 1}`,
          confidence: bestMatch.matchScore,
          attempts,
          notes: bestMatch.name,
          apiCalls,
        };
      }

      attempts.push({ query: searchName, matched: false });
    }

    return {
      success: false,
      attempts,
      notes: 'Steam ID not found',
      apiCalls,
    };
  }

  parseSteamIdFromUrl(url?: string | null): number | null {
    return this.extractSteamAppIdFromUrl(url);
  }

  private extractSteamAppIdFromUrl(url?: string | null): number | null {
    if (!url) return null;
    const match = url.match(/app\/(\d+)/);
    if (match && match[1]) {
      return Number(match[1]);
    }
    return null;
  }

  private async getSteamAppList(): Promise<{ appid: number; name: string }[]> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        const now = Date.now();
        if (
          this.steamAppListCache &&
          now - this.cacheTimestamp < this.CACHE_DURATION
        ) {
          return this.steamAppListCache;
        }

        const response = await axios.get(STEAM_API.APPLIST_URL, {
          timeout: STEAM_API.DEFAULT_TIMEOUT,
          headers: {
            'User-Agent': STEAM_API.USER_AGENT,
          },
        });

        const appList = response.data?.applist?.apps || [];
        if (!Array.isArray(appList) || appList.length === 0) {
          this.logger.warn('Steam GetAppList API returned empty result');
          return [];
        }

        this.steamAppListCache = appList;
        this.cacheTimestamp = now;
        return appList;
      },
      this.logger,
      {
        context: 'Steam GetAppList API',
        identifier: 'appList',
        rethrow: false,
        defaultMessage: 'Steam GetAppList API 호출 실패',
      },
    ).then((result) => result || []);
  }

  private buildSearchNames(gameName: string, strategies?: string[]): string[] {
    const base = gameName.trim();
    const sanitized = base.replace(/[:®™©]/gi, '').trim();

    const searchNames = new Set<string>([
      sanitized,
      sanitized.replace(/-/g, ' '),
      sanitized.replace(/\s+/g, ' '),
      slugify(sanitized, { lower: true, strict: true }),
    ]);

    (strategies || []).forEach((strategy) => {
      if (strategy) {
        searchNames.add(strategy);
      }
    });

    return Array.from(searchNames.values()).filter(Boolean);
  }

  private filterAppsByName(
    searchName: string,
    appList: { appid: number; name: string }[],
  ): { appid: number; name: string; score: number }[] {
    const normalizedQuery = slugify(searchName, { lower: true, strict: true });

    return appList
      .map((app) => {
        const slug = slugify(app.name, { lower: true, strict: true });
        const includesScore = slug.includes(normalizedQuery) ? 0.8 : 0;
        const exactScore = slug === normalizedQuery ? 1 : 0;
        const prefixScore = slug.startsWith(normalizedQuery) ? 0.9 : 0;

        const score = Math.max(exactScore, prefixScore, includesScore);
        return { appid: app.appid, name: app.name, score };
      })
      .filter((app) => app.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private findBestAppMatchOptimized(
    searchName: string,
    filteredApps: { appid: number; name: string; score: number }[],
  ) {
    if (filteredApps.length === 0) return null;

    const best = filteredApps[0];
    const matchScore = best.score;

    return {
      appid: best.appid,
      name: best.name,
      matchScore,
      searchName,
    };
  }
}
