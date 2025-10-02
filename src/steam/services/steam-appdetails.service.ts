import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { SteamReleaseDateRaw } from 'src/entities/enums';

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
  private readonly requestDelay: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    // Steam AppDetails API Rate Limit (안전 기준)
    // 공식 권장: 초당 200 요청 → 5ms 간격
    // 안전 마진 적용: 300ms (초당 3.3 요청, IP 밴 방지)
    this.requestDelay = parseInt(
      this.configService.get<string>('STEAM_APPDETAILS_DELAY') || '300',
      10,
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
      if (this.requestDelay > 0) {
        this.logger.debug(`    ⏳ Rate Limit 지연: ${this.requestDelay}ms`);
        await this.delay(this.requestDelay);
      }

      const url = `${this.steamStoreUrl}/appdetails`;
      const requestStart = Date.now();
      const response = await firstValueFrom(
        this.httpService.get(url, {
          params: {
            appids: appId,
            cc: 'kr', // 한국 지역
            l: 'korean', // 한국어
          },
          timeout: 10000,
        }),
      );

      const requestDuration = Date.now() - requestStart;
      this.logger.debug(`    ⏱️  HTTP 요청: ${requestDuration}ms`);

      const appData = response.data?.[appId];

      if (!appData?.success || !appData?.data) {
        this.logger.warn(`⚠️ Steam AppDetails 없음: AppID ${appId}`);
        return null;
      }

      const data = appData.data;

      // 게임이 아닌 경우 제외 (DLC, Software 등)
      if (!this.isGameType(data)) {
        this.logger.debug(`📋 게임이 아님: AppID ${appId} (${data.type})`);
        return null;
      }
      return this.parseAppDetails(data);
    } catch (error) {
      // 429 에러 (Rate Limit) 특별 처리
      if (error.response?.status === 429) {
        this.logger.error(
          `🚨 AppDetails Rate Limit 초과 (429) - AppID ${appId}`,
        );
        // 429 발생 시 더 긴 지연 적용 (1초 추가 대기)
        await this.delay(1000);
      }

      this.logger.error(
        `❌ Steam AppDetails 실패 - AppID ${appId}: ${error.message}`,
      );
      return null;
    }
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
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
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
  header_image?: string;
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
