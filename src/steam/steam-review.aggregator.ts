import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { ErrorHandlerUtil } from '../common/utils/error-handler.util';
import { STEAM_API } from '../common/constants/api.constants';
import {
  SteamReviewApiOptions,
  SteamReviewSummaryResult,
  SteamReviewsApiResponse,
} from '../types/steam.types';

@Injectable()
export class SteamReviewAggregator {
  private readonly logger = new Logger(SteamReviewAggregator.name);

  async fetchSummary(
    steamId: number,
    options: SteamReviewApiOptions = {},
  ): Promise<SteamReviewSummaryResult> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        const merged: Required<SteamReviewApiOptions> = {
          language: 'all',
          review_type: 'all',
          purchase_type: 'all',
          num_per_page: 0,
          cursor: '*',
          ...options,
        };

        const response = await axios.get<SteamReviewsApiResponse>(
          `http://store.steampowered.com/appreviews/${steamId}/`,
          {
            params: {
              json: 1,
              language: merged.language,
              review_type: merged.review_type,
              purchase_type: merged.purchase_type,
              num_per_page: merged.num_per_page,
              cursor: merged.cursor,
            },
            timeout: STEAM_API.DEFAULT_TIMEOUT,
            headers: {
              'User-Agent': STEAM_API.USER_AGENT,
            },
          },
        );

        const data = response.data;
        if (data.success !== 1 || !data.query_summary) {
          this.logger.debug(
            `Steam 리뷰 API 실패: ${steamId} - success=${data.success}`,
          );
          return this.createEmptySummary(false);
        }

        const summary = data.query_summary;

        return {
          success: true,
          num_reviews: summary.num_reviews,
          review_score: summary.review_score,
          review_score_desc: summary.review_score_desc,
          total_positive: summary.total_positive,
          total_negative: summary.total_negative,
          total_reviews: summary.total_reviews,
        };
      },
      this.logger,
      {
        context: 'Steam 리뷰 조회',
        identifier: steamId.toString(),
        rethrow: false,
        defaultMessage: 'Steam 리뷰 조회 실패',
      },
    ).then((result) => result || this.createEmptySummary(false));
  }

  private createEmptySummary(success: boolean): SteamReviewSummaryResult {
    return {
      success,
      num_reviews: 0,
      review_score: 0,
      review_score_desc: '리뷰 없음',
      total_positive: 0,
      total_negative: 0,
      total_reviews: 0,
    };
  }
}
