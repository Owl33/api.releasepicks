import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { ErrorHandlerUtil } from '../common/utils/error-handler.util';
import { STEAM_API } from '../common/constants/api.constants';
import { SharedMapper } from '../unified-game/persistence/mappers/shared.mapper';
import {
  GameCalendarSteamData,
  SteamApiOptions,
  SteamAppData,
  SteamAppDetailsResponse,
} from '../types/steam.types';
import { SteamReviewSummary as CalendarSteamReviewSummary } from '../types/domain.types';

@Injectable()
export class SteamDetailLoader {
  private readonly logger = new Logger(SteamDetailLoader.name);

  private readonly DEFAULT_OPTIONS: SteamApiOptions = {
    language: 'korean',
    country_code: 'KR',
    timeout: STEAM_API.DEFAULT_TIMEOUT,
  };

  async fetchAppDetails(
    steamId: number,
    options?: SteamApiOptions,
  ): Promise<SteamAppData | null> {
    const merged = { ...this.DEFAULT_OPTIONS, ...options };

    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        const params = new URLSearchParams({
          appids: steamId.toString(),
          l: merged.language || 'korean',
          cc: merged.country_code || 'KR',
        });

        const response = await axios.get<SteamAppDetailsResponse>(
          `${STEAM_API.APPDETAILS_URL}?${params.toString()}`,
          {
            timeout: merged.timeout,
            headers: {
              'User-Agent': STEAM_API.USER_AGENT,
            },
          },
        );

        const appData = response.data[steamId.toString()];
        if (!appData || !appData.success || !appData.data) {
          this.logger.warn(`Steam appDetails invalid response for ${steamId}`);
          return null;
        }

        return appData.data;
      },
      this.logger,
      {
        context: 'Steam appDetails API',
        identifier: steamId.toString(),
        rethrow: false,
        defaultMessage: 'Steam appDetails API 호출 실패',
      },
    ).then((result) => result || null);
  }

  convertToCalendarData(appData: SteamAppData): GameCalendarSteamData {
    const priceInfo = this.extractPriceInfo(
      appData.price_overview,
      appData.is_free,
    );
    const reviewSummary = this.buildReviewSummaryFromAppData(appData);

    return {
      steam_id: appData.steam_appid,
      original_name: appData.name,
      korea_name: this.extractKoreanName(appData.name),
      price: priceInfo.price,
      currency: priceInfo.currency,
      steam_type: appData.type,
      description: appData.short_description,
      korean_description: appData.detailed_description,
      developers: appData.developers || [],
      publishers: appData.publishers || [],
      release_date: appData.release_date?.date,
      required_age: appData.required_age,
      categories: SharedMapper.normalizeSteamCategories(
        appData.categories || [],
      ),
      image: appData.header_image,
      is_full_game: appData.type === 'game',
      fullgame_info: appData.fullgame,
      dlc_list: SharedMapper.normalizeNumberArray(appData.dlc || []),
      parent_appid: appData.fullgame?.appid
        ? Number(appData.fullgame.appid)
        : undefined,
      review_summary: reviewSummary,
      screenshots: SharedMapper.normalizeScreenshots(
        appData.screenshots?.map((s) => s.path_full),
      ),
      website: appData.website,
      is_free: priceInfo.isFree,
      store_url: `https://store.steampowered.com/app/${appData.steam_appid}`,
      metacritic: appData.metacritic || null,
    };
  }

  private extractKoreanName(name: string): string | undefined {
    if (!name) return undefined;
    const koreanMatch = name.match(/[가-힣\s]+/g);
    if (koreanMatch) {
      const korean = koreanMatch.join(' ').trim();
      if (korean.length > 1) {
        return korean;
      }
    }
    return undefined;
  }

  private extractPriceInfo(
    priceOverview: SteamAppData['price_overview'],
    isFree: boolean,
  ): { price: string; currency?: string; isFree: boolean } {
    if (isFree) {
      return { price: '무료', currency: priceOverview?.currency, isFree: true };
    }

    if (priceOverview) {
      return {
        price: priceOverview.final_formatted || 'N/A',
        currency: priceOverview.currency,
        isFree: false,
      };
    }

    return { price: 'N/A', currency: undefined, isFree: false };
  }

  private buildReviewSummaryFromAppData(
    appData: SteamAppData,
  ): CalendarSteamReviewSummary | undefined {
    if (
      appData.review_score === undefined &&
      appData.review_score_desc === undefined &&
      appData.total_reviews === undefined
    ) {
      return undefined;
    }

    return {
      review_score: appData.review_score,
      review_score_desc: appData.review_score_desc,
      total_positive: appData.total_positive,
      total_negative: appData.total_negative,
      total_reviews: appData.total_reviews,
    };
  }
}
