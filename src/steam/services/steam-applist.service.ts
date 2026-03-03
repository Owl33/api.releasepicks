import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { SteamApp } from '../types';
import { shouldExcludeSteamAppName } from '../utils/steam-app-filters.util';

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
  private readonly steamKey: string;

  constructor(
    private readonly httpService: HttpService,
    config: ConfigService,
  ) {
    this.steamKey = config.get<string>('STEAM_API_KEY') || '';
  }

  /**
   * Steam AppList 전체 수집
   * API: https://api.steampowered.com/ISteamApps/GetAppList/v2/
   *
   * @returns Steam 앱 목록 (appid, name)
   */
async fetchFullAppList(): Promise<SteamApp[]> {
  try {
    this.logger.log("🚀 Steam AppList 전체 수집 시작 (IStoreService/GetAppList)");

    // Steam 문서: default 10k, max 50k
    const MAX_RESULTS = 50_000; 

    const all: SteamApp[] = [];
    const seen = new Set<number>();

    let cursor = 0;            // last_appid로 이어받는 커서
    let page = 0;
    const MAX_PAGES_GUARD = 50_000; // 혹시 모를 무한루프 방지

    while (page < MAX_PAGES_GUARD) {
      page += 1;

      const response = await firstValueFrom(
        this.httpService.get(`${this.steamApiUrl}/IStoreService/GetAppList/v1/`, {
          timeout: 60_000,
          params: {
            key: this.steamKey,
            max_results: MAX_RESULTS,
            last_appid: cursor,
            // 필요하면: include_games/include_dlc/include_software/include_videos/include_hardware
          },
        }),
      );

      // IStoreService 응답은 보통 data.response 아래로 옴
      const data = response.data;
      const resp = data?.response ?? data?.applist ?? data; // 혹시 형태가 다른 경우 방어
      const appsRaw: any[] = resp?.apps ?? [];
      const haveMore: boolean = Boolean(resp?.have_more_results);
      const nextCursor: number = Number(resp?.last_appid ?? 0);

      // 페이지가 비었으면 종료
      if (!Array.isArray(appsRaw) || appsRaw.length === 0) {
        this.logger.warn(`⚠️ page=${page} apps=0 => 종료 (cursor=${cursor})`);
        break;
      }

      // ✅ "중복 페이지" 방지 핵심:
      // 요청한 cursor와 응답 last_appid가 같으면 진행이 멈춘 것(중복/스턱) → 이 페이지는 합치지 않고 종료
      if (nextCursor === cursor) {
        this.logger.warn(
          `⚠️ cursor 진행 없음(nextCursor==cursor==${cursor}) => 중복 페이지로 판단, 합치지 않고 종료`,
        );
        break;
      }

      // 이 페이지 데이터 합치기(중복 appid는 Set으로 스킵)
      let added = 0;
      for (const app of appsRaw) {
        const appid = Number(app?.appid);
        if (!Number.isFinite(appid) || appid <= 0) continue;

        // 기존 로직 유지: 유효한 게임만
        if (!this.isValidGameApp(app)) continue;

        if (seen.has(appid)) continue;
        seen.add(appid);

        all.push({
          appid,
          name: (app?.name ?? "").trim(),
        });

        added += 1;
      }

      this.logger.log(
        `📄 page=${page} raw=${appsRaw.length} added=${added} total=${all.length} cursor=${cursor} -> next=${nextCursor} haveMore=${haveMore}`,
      );

      // 다음 페이지로 이동
      cursor = nextCursor;

      // 문서 플래그 기준으로 정상 종료
      if (!haveMore) break;
    }

    this.logger.log(`📥 Steam AppList 수집 완료: ${all.length}개 (valid & dedup)`);

    return all;
  } catch (error) {
    this.logger.error(`❌ Steam AppList 수집 실패: ${error}`);
    throw new Error(`Steam AppList API 호출 실패: ${error}`);
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

    if (shouldExcludeSteamAppName(name)) {
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
