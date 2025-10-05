import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { setTimeout as sleep } from 'timers/promises';
import { SteamReleaseDateRaw } from '../../entities/enums';
import { getGlobalRateLimiter } from '../../common/concurrency/global-rate-limiter';
import {
  rateLimitMonitor,
  RateLimitExceededError,
} from '../../common/concurrency/rate-limit-monitor';
import { FixedWindowRateLimiter } from '../../common/concurrency/fixed-window-rate-limiter';

/**
 * Steam AppDetails 서비스
 * FINAL-ARCHITECTURE-DESIGN Phase 1 구현
 *
 * 역할: Steam Store API를 통한 개별 게임 상세정보 수집
 * 특징: Rate Limit 적용, 가격/출시일/스크린샷 등 수집
 */
@Injectable()
export class SteamAppDetailsService {
  private readonly logger = new Logger(SteamAppDetailsService.name);
  private readonly steamStoreUrl = 'https://store.steampowered.com/api';
  private readonly globalLimiter = getGlobalRateLimiter();
  private readonly spacingMs: number;
  private readonly rateLimiter: FixedWindowRateLimiter;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.spacingMs = Number(
      this.configService.get<string>('STEAM_APPDETAILS_SPACING_MS') ?? '150',
    );
    const maxPerWindow = Number(
      this.configService.get<string>('STEAM_APPDETAILS_WINDOW_MAX') ?? '200',
    );
    const windowSeconds = Number(
      this.configService.get<string>('STEAM_APPDETAILS_WINDOW_SECONDS') ??
        '310',
    );
    this.rateLimiter = new FixedWindowRateLimiter(
      maxPerWindow,
      windowSeconds * 1000,
    );
  }

  /**
   * Steam AppDetails 조회
   * API: https://store.steampowered.com/api/appdetails?appids={appid}
   *
   * @param appId Steam AppID
   * @returns Steam 게임 상세정보
   */
  async fetchAppDetails(appId: number): Promise<SteamAppDetails | null> {
    try {
      const startTime = Date.now();

      // Rate Limiting
      const primary = await this.requestAppDetails(appId, {
        cc: 'kr',
        lang: 'korean',
      });

      if (primary) {
        rateLimitMonitor.reportSuccess('steam:details');
        return primary;
      }

      return null;
    } catch (error) {
      // 429 에러 (Rate Limit) 특별 처리
      if (error.response?.status === 429) {
        this.logger.error(
          `🚨 AppDetails Rate Limit 초과 (429) - AppID ${appId}`,
        );
        // 429 발생 시 더 긴 지연 적용 (1초 추가 대기)
        await sleep(1000);
        this.globalLimiter.backoff('steam:details', 0.5, 30_000);

        const { pauseMs, exceeded } = rateLimitMonitor.report429(
          'steam:details',
          30_000,
        );
        this.logger.warn(`⏸️ AppDetails 429 → ${pauseMs}ms 대기`);
        await sleep(pauseMs);

        if (exceeded) {
          throw new RateLimitExceededError('steam:details');
        }
        return null;
      }

      if (error.response?.status === 403) {
        this.logger.warn(
          `🚧 AppDetails 403 (Access Denied) - AppID ${appId} → fallback en-US`,
        );
        try {
          const fallback = await this.requestAppDetails(appId, {
            cc: 'us',
            lang: 'english',
          });
          if (fallback) {
            rateLimitMonitor.reportSuccess('steam:details');
            return fallback;
          }
        } catch (fallbackError: any) {
          this.logger.error(
            `❌ AppDetails fallback 실패 - AppID ${appId}: ${fallbackError?.message ?? fallbackError}`,
          );
        }
      }

      this.logger.error(
        `❌ Steam AppDetails 실패 - AppID ${appId}: ${error.message}`,
      );
      return null;
    }
  }

  private async requestAppDetails(
    appId: number,
    opts: { cc: string; lang: string },
  ): Promise<SteamAppDetails | null> {
    await rateLimitMonitor.waitIfPaused('steam:details');
    await this.rateLimiter.take();
    if (this.spacingMs > 0) {
      const jitter = Math.floor(
        Math.random() * Math.max(1, this.spacingMs / 2),
      );
      await sleep(this.spacingMs + jitter);
    }
    const url = `${this.steamStoreUrl}/appdetails`;
    const requestStart = Date.now();
    const response = await firstValueFrom(
      this.httpService.get(url, {
        params: {
          appids: appId,
          cc: opts.cc,
          l: opts.lang,
        },
        timeout: 10000,
        headers: this.buildRequestHeaders(opts.lang),
      }),
    );

    const requestDuration = Date.now() - requestStart;
    this.logger.debug(
      `    ⏱️  HTTP 요청(${opts.cc}/${opts.lang}): ${requestDuration}ms`,
    );

    const appData = response.data?.[appId];

    if (!appData?.success || !appData?.data) {
      this.logger.warn(`⚠️ Steam AppDetails 없음: AppID ${appId}`);
      return null;
    }

    const data = appData.data;

    if (!this.isGameType(data)) {
      this.logger.debug(`📋 게임이 아님: AppID ${appId} (${data.type})`);
      return null;
    }

    return this.parseAppDetails(data);
  }

  private buildRequestHeaders(lang: string) {
    const language =
      lang === 'korean'
        ? 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        : 'en-US,en;q=0.9';
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept-Language': language,
      Accept: 'application/json, */*;q=0.8',
    };
  }

  /**
   * Steam 데이터를 파싱하여 구조화
   *
   * @param data Steam API 응답 데이터
   * @returns 파싱된 게임 상세정보
   */
  private parseAppDetails(data: any): SteamAppDetails {
    return {
      steam_appid: data.steam_appid,
      name: data.name,
      type: data.type,
      fullgame: data.fullgame || {},
      // 출시 정보
      release_date: data.release_date,
      coming_soon: data.release_date?.coming_soon || false,

      // 기본 정보
      short_description: data.short_description,
      detailed_description: data.detailed_description,
      website: data.website || null,

      // 미디어
      header_image: data.header_image,
      screenshots: data.screenshots?.slice(0, 5).map((s) => s.path_full) || [],
      movies: data.movies?.slice(0, 1).map((m) => m.mp4?.max) || [],

      // 분류
      genres: data.genres?.map((g) => g.description) || [],
      categories: data.categories?.map((c) => c.description) || [],

      // 회사 정보
      developers: data.developers || [],
      publishers: data.publishers || [],

      // 가격 정보
      price_overview: this.parsePriceOverview(data.price_overview),
      is_free: data.is_free || false,

      // 플랫폼 지원
      platforms: this.parsePlatforms(data.platforms),

      // 지원 언어
      supported_languages: this.parseLanguages(data.supported_languages),

      // 메타크리틱 점수
      metacritic: data.metacritic?.score || null,
    };
  }

  /**
   * 출시일 정보 파싱
   */
  private parseReleaseDate(releaseDate: any): Date | null {
    if (!releaseDate?.date) return null;

    try {
      // Steam 날짜 형식: "DD MMM, YYYY" (예: "13 May, 2020")
      const dateStr = releaseDate.date.replace(/,/g, '');
      return new Date(dateStr);
    } catch {
      return null;
    }
  }

  /**
   * 가격 정보 파싱
   */
  private parsePriceOverview(priceOverview: any) {
    if (!priceOverview) return null;

    return {
      initial: priceOverview.initial,
      final: priceOverview.final,
      discount_percent: priceOverview.discount_percent,
      initial_formatted: priceOverview.initial_formatted,
      final_formatted: priceOverview.final_formatted,
    };
  }

  /**
   * 플랫폼 지원 정보 파싱
   */
  private parsePlatforms(platforms: any): string[] {
    if (!platforms) return [];

    const supportedPlatforms: string[] = [];
    if (platforms.windows) supportedPlatforms.push('pc');
    if (platforms.mac) supportedPlatforms.push('mac');
    if (platforms.linux) supportedPlatforms.push('linux');

    return supportedPlatforms;
  }

  /**
   * 지원 언어 파싱
   */
  private parseLanguages(languages?: string): string[] {
    if (!languages) return [];

    // 1) <br> 이후의 각주/설명은 잘라낸다
    const beforeBreak = languages.split(/<br\s*\/?>/i)[0] ?? languages;

    // 2) 남은 HTML 태그 제거
    const plain = beforeBreak.replace(/<[^>]+>/g, '');

    // 3) 콤마로 분리 후 공백 제거
    const parts = plain
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // 4) 언어 토큰 끝에 붙은 각주(*) 제거
    const cleaned = parts.map((s) => s.replace(/\*+$/g, '').trim());

    // 5) 중복 제거, 최대 10개 제한
    const dedup: string[] = [];
    for (const lang of cleaned) {
      if (!dedup.includes(lang)) dedup.push(lang);
    }
    return dedup.slice(0, 10);
  }

  /**
   * 게임 타입 여부 확인
   */
  private isGameType(data: any): boolean {
    const validTypes = ['game', 'dlc'];
    return validTypes.includes(data.type?.toLowerCase());
  }

  /**
   * 지연 함수 (Rate Limiting)
   */
}

/**
 * Steam AppDetails 인터페이스
 */
export interface SteamAppDetails {
  fullgame: any;
  steam_appid: number;
  name: string;
  type: string;

  // 출시 정보
  release_date: SteamReleaseDateRaw;
  coming_soon: boolean;

  // 기본 정보
  short_description?: string;
  detailed_description?: string;
  website?: string | null;

  // 미디어
  header_image: string;
  screenshots: string[];
  movies: string[];

  // 분류
  genres: string[];
  categories: string[];

  // 회사 정보
  developers: string[];
  publishers: string[];

  // 가격 정보
  price_overview: any;
  is_free: boolean;

  // 플랫폼
  platforms: string[];

  // 지원 언어
  supported_languages: string[];

  // 메타크리틱
  metacritic: number | null;
}
