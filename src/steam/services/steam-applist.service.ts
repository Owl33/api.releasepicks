import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { SteamApp } from '../types';

/**
 * Steam AppList 서비스
 * FINAL-ARCHITECTURE-DESIGN Phase 1 구현
 *
 * 역할: Steam AppList API v2를 통한 전체 게임 목록 수집
 * 특징: 15만개+ 게임 데이터, 무료 API, Rate Limit 없음
 */
@Injectable()
export class SteamAppListService {
  private readonly logger = new Logger(SteamAppListService.name);
  private readonly steamApiUrl = 'https://api.steampowered.com';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Steam AppList 전체 수집
   * API: https://api.steampowered.com/ISteamApps/GetAppList/v2/
   *
   * @returns Steam 앱 목록 (appid, name)
   */
  async fetchFullAppList(): Promise<SteamApp[]> {
    try {
      this.logger.log('🚀 Steam AppList 전체 수집 시작');

      const url = `${this.steamApiUrl}/ISteamApps/GetAppList/v2/`;
      const response = await firstValueFrom(
        this.httpService.get(url, {
          timeout: 30000, // 30초 타임아웃 (대용량 데이터)
        }),
      );

      const apps = response.data?.applist?.apps || [];
      this.logger.log(`📥 Steam AppList 수집 완료: ${apps.length}개`);

      // 유효한 게임만 필터링
      const validApps = apps.filter((app) => this.isValidGameApp(app));
      this.logger.log(`✅ 유효한 게임 필터링: ${validApps.length}개`);

      return validApps
        .map((app) => {
          const appid = Number(app.appid);
          if (!Number.isFinite(appid) || appid <= 0) {
            return null;
          }
          return {
            appid,
            name: app.name?.trim() || '',
          } satisfies SteamApp | null;
        })
        .filter((app): app is SteamApp => app !== null);
    } catch (error) {
      this.logger.error(`❌ Steam AppList 수집 실패: ${error.message}`);
      throw new Error(`Steam AppList API 호출 실패: ${error.message}`);
    }
  }

  /**
   * 유효한 게임 앱 여부 검증
   *
   * @param app Steam 앱 데이터
   * @returns 유효한 게임 여부
   */
  private isValidGameApp(app: any): boolean {
    // 기본 필드 검증
    if (!app.appid || !app.name) {
      return false;
    }

    const name = app.name.toLowerCase();

    const excludePatterns: RegExp[] = [
      /\bsoundtrack\b/,
      /\boriginal soundtrack\b/,
      /\boriginal sound track\b/,
      /\bwallpaper\b/,
      /\bscreensaver\b/,
      /\bsdk\b/,
      /\bdevelopment kit\b/,
      /\bserver\b/,
      /\bbenchmark\b/,
      /\btest\b/,
      /\bsample\b/,
      /\btrailer\b/,
      /\bvideo\b/,
    ];

    if (excludePatterns.some((pattern) => pattern.test(name))) {
      return false;
    }

    // 너무 짧거나 긴 이름 제외
    if (name.length < 2 || name.length > 200) {
      return false;
    }

    return true;
  }

  /**
   * 증분 업데이트를 위한 최신 앱 목록 조회
   *
   * @param sinceAppId 마지막 처리된 AppID
   * @returns 신규/변경된 앱 목록
   */
  async fetchNewApps(sinceAppId: number = 0): Promise<SteamApp[]> {
    const allApps = await this.fetchFullAppList();

    // sinceAppId 이후의 앱들만 반환
    return allApps.filter((app) => app.appid > sinceAppId);
  }

  /**
   * 인기도 기반 우선순위 앱 목록 조회
   *
   * @param limit 반환할 앱 개수
   * @returns 우선순위 앱 목록
   */
  async fetchPriorityApps(limit: number = 5000): Promise<SteamApp[]> {
    const allApps = await this.fetchFullAppList();

    // AppID 기준 최신순으로 정렬 (최신 게임이 더 관심도가 높을 가능성)
    const sortedApps = allApps.sort((a, b) => b.appid - a.appid);

    return sortedApps.slice(0, limit);
  }
}
