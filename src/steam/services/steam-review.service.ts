import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { getGlobalRateLimiter } from '../../common/concurrency/global-rate-limiter';

/**
 * Steam Review 서비스
 *
 * 역할: Steam Reivw API를 통한 개별 게임 리뷰 수집
 * 특징: Rate Limit 적용, 가격/출시일/스크린샷 등 수집
 */
@Injectable()
export class SteamReviewService {
  private readonly logger = new Logger(SteamReviewService.name);
  private readonly steamReviewUrl = 'https://store.steampowered.com/appreviews';
  private readonly globalLimiter = getGlobalRateLimiter();

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    // Steam AppDetails API Rate Limit (안전 기준)
    // 공식 권장: 초당 200 요청 → 5ms 간격
    // 안전 마진 적용: 300ms (초당 3.3 요청, IP 밴 방지)
  }

  /**
   * Steam AppReview 조회
   * API: https://store.steampowered.com/appreviews/440?json=1
   *
   * @param appId Steam AppID
   * @returns Steam 게임 상세정보
   */
  async fetchAppReview(appId: number): Promise<SteamReviewData | null> {
    try {
      const startTime = Date.now();

      // Rate Limiting
      const url = `${this.steamReviewUrl}/${appId}?json=1&language=all&purchase_type=all`;
      const requestStart = Date.now();
      const response = await firstValueFrom(
        this.httpService.get(url, {
          timeout: 10000,
        }),
      );

      const requestDuration = Date.now() - requestStart;
      this.logger.debug(`    ⏱️  HTTP 요청: ${requestDuration}ms`);

      const data = response.data;

      if (data.success === 1 && data.query_summary) {
        return {
          total_reviews: data.query_summary.total_reviews,
          review_score_desc: data.query_summary.review_score_desc,
        };
      }

      return null;
    } catch (error) {
      // 429 에러 (Rate Limit) 특별 처리
      if (error.response?.status === 429) {
        this.logger.error(
          `🚨 AppRevies Rate Limit 초과 (429) - AppID ${appId}`,
        );
        // 429 발생 시 더 긴 지연 적용 (1초 추가 대기)
        await new Promise((resolve) => setTimeout(resolve, 1000));
        this.globalLimiter.backoff('steam:reviews', 0.5, 30_000);
      }

      this.logger.error(
        `❌ Steam AppRevies 실패 - AppID ${appId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * 지연 함수 (Rate Limiting)
   */
}

/**
 * Steam AppDetails 인터페이스
 */

interface SteamReviewData {
  total_reviews: number;
  review_score_desc: string; // "Very Positive", "Mixed" 등
}
