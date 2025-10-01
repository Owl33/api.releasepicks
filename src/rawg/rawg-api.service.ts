// src/services/rawg/rawg-api.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosResponse } from 'axios';
import {
  RAWG_API_BASE_URL,
  RAWG_COLLECTION,
  RAWG_PLATFORM_IDS,
} from './config/rawg.config';
import { RawgGameSearchResult, RawgGameDetails } from './rawg.types';

@Injectable()
export class RawgApiService {
  private readonly logger = new Logger(RawgApiService.name);
  private readonly baseUrl = RAWG_API_BASE_URL;
  private readonly apiKey: string;

  private readonly rateLimit = 20;
  private requestCount = 0;
  private lastResetTime = Date.now();

  private failureCount = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private lastFailureTime: Date | null = null;
  private readonly failureThreshold = 5;
  private readonly timeout = 5 * 60 * 1000;

  constructor(
    private readonly httpService: HttpService,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('RAWG_API_KEY') || '';
    if (!this.apiKey)
      this.logger.warn('⚠️ RAWG API KEY 미설정: RAWG_API_KEY를 확인하세요.');
  }

  // ✅ 기존 이름 유지
  async searchGames(
    gameName: string,
    options: {
      search_precise?: boolean;
      page_size?: number;
      page?: number;
    } = {},
  ): Promise<RawgGameSearchResult[]> {
    const params = {
      key: this.apiKey,
      search: gameName,
      search_precise: options.search_precise ?? true,
      page_size: options.page_size ?? 5,
      page: options.page ?? 1,
    };
    const res = await this.callApiWithRetry<{
      results: RawgGameSearchResult[];
    }>('/games', params);
    return res?.results ?? [];
  }

  // ✅ 기존 이름 유지 — 월 수집에서는 options.platforms로 "통합 ID" 전달해 사용
  async searchGamesByPlatform(
    platformSlug: string,
    options: {
      platforms?: string; // 권장: "187,18,186,1,7" 같은 통합 문자열 직접 전달
      page_size?: number;
      ordering?: string;
      metacritic?: string;
      dates?: string; // "YYYY-MM-01,YYYY-MM-마지막일"
    } = {},
  ): Promise<RawgGameSearchResult[]> {
    const platformIds =
      options.platforms || this.getPlatformIdsFromSlug(platformSlug); // 하위호환

    const params: any = {
      key: this.apiKey,
      platforms: platformIds,
      page_size: options.page_size || RAWG_COLLECTION.pageSize,
      ordering: options.ordering || RAWG_COLLECTION.ordering,
    };
    if (options.dates) params.dates = options.dates;
    else {
      // 레거시 fallback (월 수집에서는 반드시 dates 전달)
      const y = new Date().getFullYear();
      params.dates = `${y - 2}-01-01,${y}-12-31`;
    }
    if (options.metacritic) params.metacritic = options.metacritic;

    const res = await this.callApiWithRetry<{
      results: RawgGameSearchResult[];
    }>('/games', params);
    return res?.results ?? [];
  }

  // ✅ 기존 이름 유지
  async getGameDetails(rawgId: number): Promise<RawgGameDetails | null> {
    const res = await this.callApiWithRetry<RawgGameDetails>(
      `/games/${rawgId}`,
      { key: this.apiKey },
    );
    return res ?? null;
  }

  // ===== Phase 5.5: DLC 부모 게임 조회 API =====
  /**
   * RAWG DLC의 부모 게임(본편) 목록 조회
   * @param rawgId - DLC 게임의 RAWG ID
   * @returns 부모 게임 목록 (parent_games_count > 0일 때 호출)
   */
  async getParentGames(rawgId: number): Promise<RawgGameSearchResult[]> {
    const res = await this.callApiWithRetry<{ results: RawgGameSearchResult[] }>(
      `/games/${rawgId}/parent-games`,
      { key: this.apiKey },
    );
    return res?.results ?? [];
  }

  // 포함 검사 기반 slug → 최신+직전 세대 ID 문자열 (하위호환용)
  private getPlatformIdsFromSlug(platformSlug: string): string {
    const s = (platformSlug || '').toLowerCase();
    if (s.includes('playstation'))
      return RAWG_PLATFORM_IDS.playstation.join(',');
    if (s.includes('xbox')) return RAWG_PLATFORM_IDS.xbox.join(',');
    if (s.includes('nintendo')) return RAWG_PLATFORM_IDS.nintendo.join(',');
    return [
      ...RAWG_PLATFORM_IDS.playstation,
      ...RAWG_PLATFORM_IDS.xbox,
      ...RAWG_PLATFORM_IDS.nintendo,
    ].join(',');
  }

  // ---------------- Axios + 재시도 + 레이트리밋 + CB ----------------

  private async callApiWithRetry<T>(
    endpoint: string,
    params: Record<string, any>,
    maxRetries = RAWG_COLLECTION.retry.max,
  ): Promise<T | null> {
    if (this.state === 'OPEN') {
      if (Date.now() - (this.lastFailureTime?.getTime() || 0) > this.timeout) {
        this.state = 'HALF_OPEN';
        this.logger.log('🔄 RAWG API CB: HALF_OPEN');
      } else {
        this.logger.warn('🚫 RAWG API CB: OPEN — 요청 차단');
        return null;
      }
    }

    await this.checkRateLimit();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response: AxiosResponse<T> = await firstValueFrom(
          this.httpService.get(`${this.baseUrl}${endpoint}`, {
            params,
            timeout: 10000,
            headers: { 'User-Agent': 'GameCalendarBot/1.0' },
          }),
        );
        this.onSuccess();
        return response.data;
      } catch (error: any) {
        this.logger.warn(
          `⚠️ RAWG API 실패 (${attempt}/${maxRetries}) ${endpoint}: ${error?.message}`,
        );

        if (error?.response?.status === 429) {
          const retryAfter = Number(
            error.response.headers['retry-after'] || 60,
          );
          this.logger.warn(`⏳ RateLimit — ${retryAfter}s 대기`);
          await this.delay(retryAfter * 1000);
          continue;
        }
        if (attempt < maxRetries) {
          const delayMs = Math.max(
            RAWG_COLLECTION.retry.baseDelayMs,
            Math.min(
              10000,
              RAWG_COLLECTION.retry.baseDelayMs * Math.pow(2, attempt - 1),
            ),
          );
          await this.delay(delayMs);
        } else {
          this.onFailure();
        }
      }
    }

    this.logger.error(`❌ RAWG API 완전 실패: ${endpoint}`);
    return null;
  }

  private async checkRateLimit() {
    const now = Date.now();
    if (now - this.lastResetTime > 60000) {
      this.requestCount = 0;
      this.lastResetTime = now;
    }
    if (this.requestCount >= this.rateLimit) {
      const wait = 60000 - (now - this.lastResetTime);
      if (wait > 0) {
        this.logger.log(`⏳ RateLimit 대기 ${Math.ceil(wait / 1000)}s`);
        await this.delay(wait);
        this.requestCount = 0;
        this.lastResetTime = Date.now();
      }
    }
    this.requestCount++;
  }
  private onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = new Date();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.logger.warn(`🚫 CB OPEN (실패 ${this.failureCount}회)`);
    }
  }
  private delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
