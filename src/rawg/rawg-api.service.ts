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
import {
  RawgGameSearchResult,
  RawgGameDetails,
  RawgGameStoreResult,
} from './rawg.types';
import { rawgMonitor } from './utils/rawg-monitor';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemEvent } from '../entities/system-event.entity';

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
  private readonly timeout = 10 * 60 * 1000;
  private last429AlertAt = 0;
  private last5xxAlertAt = 0;

  constructor(
    private readonly httpService: HttpService,
    config: ConfigService,
    @InjectRepository(SystemEvent)
    private readonly systemEventRepository: Repository<SystemEvent>,
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
      page?: number;

      ordering?: string;
      metacritic?: string;
      dates?: string; // "YYYY-MM-01,YYYY-MM-마지막일"
    } = {},
  ): Promise<RawgGameSearchResult[] | null> {
    const platformIds =
      options.platforms || this.getPlatformIdsFromSlug(platformSlug); // 하위호환

    const params: any = {
      key: this.apiKey,
      platforms: platformIds,
      page: options.page || 1,

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
    if (!res) return null;
    return res.results ?? [];
  }

  // ✅ 기존 이름 유지
  async getGameDetails(rawgId: number): Promise<RawgGameDetails | null> {
    const res = await this.callApiWithRetry<RawgGameDetails>(
      `/games/${rawgId}`,
      { key: this.apiKey },
    );
    return res ?? null;
  }

  async getGameStores(rawgId: number): Promise<RawgGameStoreResult[]> {
    const res = await this.callApiWithRetry<{ results: RawgGameStoreResult[] }>(
      `/games/${rawgId}/stores`,
      { key: this.apiKey },
    );
    return res?.results ?? [];
  }
  async searchGamesByPlatformPaged(options: {
    platforms?: string;
    dates: string;
    ordering?: string;
    metacritic?: string;
    pageSize?: number; // 총 수집 목표 수 (예: 200)
    maxPages?: number; // 안전장치 (기본 10)
  }): Promise<RawgGameSearchResult[]> {
    const perPage = Math.min(
      40,
      Math.max(1, options.pageSize ?? RAWG_COLLECTION.pageSize),
    ); // RAWG 제한 고려
    const maxPages = Math.max(1, options.maxPages ?? 10);
    const targetTotal = Math.max(
      1,
      options.pageSize ?? RAWG_COLLECTION.pageSize,
    );

    const results: RawgGameSearchResult[] = [];
    let fetched = 0;
    for (let page = 1; page <= maxPages; page++) {
      const chunk = await this.searchGamesByPlatform('', {
        platforms: options.platforms,
        dates: options.dates,
        ordering: options.ordering,
        metacritic: options.metacritic,
        page_size: perPage,
        page,
      });
      if (!chunk || chunk.length === 0) break;
      results.push(...chunk);
      fetched += chunk.length;
      if (chunk.length < perPage) break; // 마지막 페이지 추정
      if (fetched >= targetTotal) break; // 목표량 도달
    }
    return results;
  }

  // ===== Phase 5.5: DLC 부모 게임 조회 API =====
  /**
   * RAWG DLC의 부모 게임(본편) 목록 조회
   * @param rawgId - DLC 게임의 RAWG ID
   * @returns 부모 게임 목록 (parent_games_count > 0일 때 호출)
   */
  async getParentGames(rawgId: number): Promise<RawgGameSearchResult[]> {
    const res = await this.callApiWithRetry<{
      results: RawgGameSearchResult[];
    }>(`/games/${rawgId}/parent-games`, { key: this.apiKey });
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
      const attemptStartedAt = Date.now();
      try {
        const response: AxiosResponse<T> = await firstValueFrom(
          this.httpService.get(`${this.baseUrl}${endpoint}`, {
            params,
            timeout: 60000,
            headers: { 'User-Agent': 'GameCalendarBot/1.0' },
          }),
        );
        this.onSuccess();
        const durationMs = Date.now() - attemptStartedAt;
        const payloadBytes = JSON.stringify(response.data ?? {}).length;
        rawgMonitor.recordSuccess({
          endpoint,
          status: response.status,
          durationMs,
          payloadBytes,
          timestamp: Date.now(),
        });
        this.evaluateAlerts();
        return response.data;
      } catch (error: any) {
        this.logger.warn(
          `⚠️ RAWG API 실패 (${attempt}/${maxRetries}) ${endpoint}: ${error?.message}`,
        );
        this.logger.warn(
          `   ↳ 요청 파라미터: ${this.buildLoggableParams(params)}`,
        );

        const status = error?.response?.status ?? 0;
        const durationMs = Date.now() - attemptStartedAt;
        const payloadBytes = error?.response?.data
          ? JSON.stringify(error.response.data).length
          : 0;
        rawgMonitor.recordError({
          endpoint,
          status,
          durationMs,
          payloadBytes,
          timestamp: Date.now(),
          attempt,
          level: status >= 500 ? 'error' : 'warn',
        });
        if (status === 429) {
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
          if (status === 429 || status >= 500) {
            await this.recordSystemEvent('rawg_api_error', {
              endpoint,
              status,
              attempt,
              params,
            });
          }
        }
      }
    }

    this.logger.error(`❌ RAWG API 완전 실패: ${endpoint}`);
    this.evaluateAlerts();
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

  private evaluateAlerts(): void {
    const snapshot = rawgMonitor.snapshot();
    const now = Date.now();

    if (
      snapshot.rateLimitCount >= 10 &&
      now - this.last429AlertAt > 5 * 60 * 1000
    ) {
      this.last429AlertAt = now;
      const message =
        'RAWG API 429가 5분 이내 10회를 초과했습니다. 파라미터/딜레이를 확인하세요.';
      this.logger.error(`🚨 [RAWG] 429 알림 – ${message}`);
      void this.recordSystemEvent('rawg_rate_limit_alert', {
        message,
        snapshot,
      });
    }

    if (
      snapshot.serverErrorCount >= 3 &&
      now - this.last5xxAlertAt > 5 * 60 * 1000
    ) {
      this.last5xxAlertAt = now;
      const message =
        'RAWG API 5xx 응답이 5분 이내 3회 이상 발생했습니다. 서비스 상태를 확인하세요.';
      this.logger.error(`🚨 [RAWG] 5xx 알림 – ${message}`);
      void this.recordSystemEvent('rawg_server_error_alert', {
        message,
        snapshot,
      });
    }
  }

  private buildLoggableParams(params: Record<string, any>): string {
    if (!params) return '{}';
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      const lowered = key.toLowerCase();
      if (
        lowered === 'key' ||
        lowered.endsWith('key') ||
        lowered.includes('token')
      ) {
        sanitized[key] = '***';
        continue;
      }
      if (typeof value === 'string' && value.length > 180) {
        sanitized[key] = `${value.slice(0, 177)}...`;
        continue;
      }
      sanitized[key] = value;
    }
    try {
      return JSON.stringify(sanitized);
    } catch {
      return '[unserializable params]';
    }
  }

  private async recordSystemEvent(
    eventName: string,
    eventData: Record<string, any>,
  ): Promise<void> {
    try {
      const event = this.systemEventRepository.create({
        event_name: eventName,
        entity_type: 'rawg',
        entity_id: 0,
        event_data: eventData,
      });
      await this.systemEventRepository.save(event);
    } catch (error) {
      this.logger.warn(
        `⚠️ RAWG 시스템 이벤트 기록 실패: ${(error as Error).message}`,
      );
    }
  }
}
