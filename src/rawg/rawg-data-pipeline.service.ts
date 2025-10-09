// src/services/rawg/rawg-data-pipeline.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { RawgApiService } from './rawg-api.service';
import { RAWG_COLLECTION, RAWG_PLATFORM_IDS } from './config/rawg.config';
import {
  generateMonthRange,
  buildMonthlyParams,
} from './utils/rawg-query-builder.util';
import { extractPlatformFamilies } from './utils/platform-normalizer';
import {
  RawgGameDetails,
  RawgGameSearchResult,
  RawgGameStoreResult,
} from './rawg.types';
import { ProcessedGameData } from '../pipeline/types/pipeline.types';
import {
  GameType,
  ReleaseStatus,
  CompanyRole,
  Platform,
  Store,
} from '../entities/enums';
import { PopularityCalculator } from '../common/utils/popularity-calculator.util';
import { rawgMonitor, RawgMonitorSnapshot } from './utils/rawg-monitor';

// YouTube 서비스 추가 (Phase 4)
import { YouTubeService } from '../youtube/youtube.service';
import { normalizeGameName } from '../common/utils/game-name-normalizer.util';

export interface CollectProcessedDataOptions {
  // 기존 호출부를 존중: 필요한 옵션만 해석 (없으면 전역 기본값 사용)
  monthsBack?: number; // default 12
  monthsForward?: number; // default 6
  limitMonths?: number; // 테스트용: 앞에서 N개월만
  ordering?: '-released' | '-added';
  metacritic?: string; // 운영 옵션
}

type ConsoleFamily = 'playstation' | 'xbox' | 'nintendo';

interface RawgIntermediate {
  rawgId: number;
  slug: string;
  name: string;
  headerImage: string;
  screenshots: string[];
  released: string | null;
  platformFamilies: ConsoleFamily[];
  added: number;
  popularityScore: number;
  isDlc: boolean;
  parentRawgId?: number;
  sourceMonth: string;
}

interface RawgMonthStat {
  month: string;
  attempt: number;
  requestCount: number;
  gameCount: number;
  durationMs: number;
  success: boolean;
  reason?: string;
}

interface RawgRetryLog {
  month: string;
  attempts: number;
  status: 'requeued' | 'failed';
  reason?: string;
}

interface RawgCollectionReport {
  startedAt: string;
  finishedAt: string;
  totalGames: number;
  months: RawgMonthStat[];
  failedMonths: string[];
  retryLogs: RawgRetryLog[];
  consoleIssues: string[];
  monitorSnapshot: RawgMonitorSnapshot;
}

interface StoreInfo {
  store: Store;
  storeAppId: string;
  storeUrl: string | null;
  family: ConsoleFamily;
}

@Injectable()
export class RawgDataPipelineService {
  private readonly logger = new Logger(RawgDataPipelineService.name);
  private lastReport: RawgCollectionReport | null = null;

  constructor(
    private readonly rawgApiService: RawgApiService,
    private readonly youtubeService: YouTubeService, // Phase 4: YouTube 서비스 주입
  ) {}

  getLatestReport(): RawgCollectionReport | null {
    return this.lastReport;
  }

  /**
   * ✅ 공개 API 이름 유지: collectProcessedData()
   * 내부 로직은 "월 단위 통합 수집(PS+Xbox+Nintendo, 각 월 최대 50개)"으로 동작
   * @returns ProcessedGameData[] - 파이프라인 컨트롤러가 기대하는 표준 형식
   */
  async collectProcessedData(
    opts: CollectProcessedDataOptions = {},
  ): Promise<ProcessedGameData[]> {
    const startedAt = Date.now();
    const pastMonths = opts.monthsBack ?? RAWG_COLLECTION.pastMonths;
    const futureMonths = opts.monthsForward ?? RAWG_COLLECTION.futureMonths;
    const limitMonths = opts.limitMonths;
    const ordering = opts.ordering ?? RAWG_COLLECTION.ordering;
    const metacritic = opts.metacritic;

    const months = generateMonthRange(pastMonths, futureMonths);
    const target =
      limitMonths && limitMonths > 0 ? months.slice(0, limitMonths) : months;

    const queue = target.map(([year, month]) => ({
      year,
      month,
      attempt: 1,
    }));
    const maxAttempts = 3;

    const unifiedPlatforms = [
      ...RAWG_PLATFORM_IDS.playstation,
      ...RAWG_PLATFORM_IDS.xbox,
      ...RAWG_PLATFORM_IDS.nintendo,
    ].join(',');

    const rawResults: RawgIntermediate[] = [];
    const seen = new Set<string>();
    const monthStats: RawgMonthStat[] = [];
    const retryLogs: RawgRetryLog[] = [];
    const failedMonths: string[] = [];
    const consoleIssues: string[] = [];

    while (queue.length) {
      const task = queue.shift()!;
      const monthKey = `${task.year}-${String(task.month).padStart(2, '0')}`;
      const stat: RawgMonthStat = {
        month: monthKey,
        attempt: task.attempt,
        requestCount: 0,
        gameCount: 0,
        durationMs: 0,
        success: false,
      };
      const monthStart = Date.now();
      let shouldRetry = false;
      let retryReason: string | undefined;

      try {
        const params = buildMonthlyParams(task.year, task.month, {
          ordering,
          metacritic,
        });
        stat.requestCount += 1;

        const games = await this.rawgApiService.searchGamesByPlatform('', {
          platforms: unifiedPlatforms,
          dates: params.dates,
          page_size: params.page_size,
          ordering: params.ordering,
          metacritic: params.metacritic,
        });
        if (!games) {
          retryReason = 'api_error';
          throw new Error('RAWG API 응답 없음');
        }

        if (!games.length) {
          retryReason = 'empty_result';
          throw new Error('조회 결과 없음');
        }

        let addedCount = 0;
        for (const g of games) {
          const key = String(g?.id || g?.slug || '');
          if (!key || seen.has(key)) continue;

          const added = typeof g.added === 'number' ? g.added : 0;
          if (added < RAWG_COLLECTION.minAdded) {
            consoleIssues.push(
              `[${monthKey}] added(${added}) < ${RAWG_COLLECTION.minAdded} → 스킵: ${g.name}`,
            );
            continue;
          }

          const popularityScore =
            PopularityCalculator.calculateRawgPopularity(added);
          if (popularityScore < RAWG_COLLECTION.popularityThreshold) {
            continue;
          }

          const families = Array.from(
            new Set(extractPlatformFamilies(g.platforms || [])),
          ) as ConsoleFamily[];

          if (!families.length) {
            consoleIssues.push(
              `[${monthKey}] 플랫폼 정보를 찾지 못했습니다: ${g.name}`,
            );
            continue;
          }

          let isDlc = false;
          let parentRawgId: number | undefined;

          if (g.parent_games_count && g.parent_games_count > 0) {
            try {
              const parentGames = await this.rawgApiService.getParentGames(
                g.id,
              );
              if (parentGames.length > 0) {
                isDlc = true;
                parentRawgId = parentGames[0].id;
                this.logger.log(
                  `✅ [RAWG-DLC] DLC 확정 - ${g.name} → 부모: ${parentGames[0].name} (rawg_id: ${parentRawgId})`,
                );
              }
            } catch (error) {
              this.logger.warn(
                `⚠️ [RAWG-DLC] 부모 게임 조회 실패 - ${g.name}: ${(error as Error).message}`,
              );
            }
          }

          // ⚠️ RAWG API의 slug는 플랫폼별 표기 차이로 중복 게임을 유발할 수 있음
          // 예: "Metal Gear Solid Delta" (RAWG) vs "METAL GEAR SOLID Δ" (Steam)
          // 해결: normalizeGameName()으로 통일된 slug 생성
          const normalizedSlug = normalizeGameName(g.name);

          rawResults.push({
            rawgId: g.id,
            slug: normalizedSlug, // ⚠️ 변경: g.slug → normalizedSlug
            name: g.name,
            parentRawgId,
            screenshots:
              g.short_screenshots?.slice(0, 5).map((s: any) => s.image) || [],
            released: g.released ?? null,
            platformFamilies: families,
            added,
            popularityScore,
            isDlc,
            headerImage: g.background_image,
            sourceMonth: monthKey,
          });
          seen.add(key);
          addedCount++;
        }

        stat.gameCount = addedCount;
        stat.success = true;
        if (!addedCount) {
          stat.reason = 'filtered';
        }
      } catch (error) {
        const message = retryReason ?? (error as Error).message;
        stat.reason = message;
        if (task.attempt < maxAttempts) {
          shouldRetry = true;
          retryReason = message;
        } else {
          failedMonths.push(monthKey);
          retryLogs.push({
            month: monthKey,
            attempts: task.attempt,
            status: 'failed',
            reason: message,
          });
          this.logger.error(
            `❌ [RAWG] 월 수집 실패 (${monthKey}) - ${message}`,
          );
        }
      } finally {
        stat.durationMs = Date.now() - monthStart;
        monthStats.push(stat);

        if (shouldRetry) {
          const retryDelay = Math.round(
            RAWG_COLLECTION.retry.baseDelayMs * Math.pow(2, task.attempt - 1),
          );
          this.logger.warn(
            `🔁 [RAWG] 재큐 ${monthKey} → attempt ${task.attempt + 1} (delay ${retryDelay}ms)`,
          );
          retryLogs.push({
            month: monthKey,
            attempts: task.attempt,
            status: 'requeued',
            reason: stat.reason,
          });
          queue.push({
            year: task.year,
            month: task.month,
            attempt: task.attempt + 1,
          });
          await this.delay(retryDelay);
        } else {
          const baseDelay =
            RAWG_COLLECTION.requestDelayMs * (task.attempt > 1 ? 1.5 : 1);
          await this.delay(baseDelay);
        }
      }
    }

    this.logger.log(
      `✨ [RAWG] 월 단위 통합 수집 완료 — unique: ${rawResults.length}`,
    );

    const processedData: ProcessedGameData[] = [];
    for (const raw of rawResults) {
      const gameData = await this.mapToProcessedGameData(raw, consoleIssues);
      processedData.push(gameData);
    }

    const report: RawgCollectionReport = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      totalGames: processedData.length,
      months: monthStats,
      failedMonths,
      retryLogs,
      consoleIssues,
      monitorSnapshot: rawgMonitor.snapshot(),
    };
    this.lastReport = report;
    await this.writeReport(report);

    return processedData;
  }

  /**
   * RAWG 원시 데이터를 ProcessedGameData 형식으로 변환
   * Phase 4: 인기도 40점 이상 게임은 YouTube 트레일러 조회
   * Phase 5.5: DLC 메타데이터 포함
   * ✅ 수정: RAWG API 상세 정보 조회 및 game_detail 전체 필드 매핑
   */
  private async mapToProcessedGameData(
    raw: RawgIntermediate,
    consoleIssues: string[],
  ): Promise<ProcessedGameData> {
    // 출시일 파싱
    const releaseDate = raw.released ? new Date(raw.released) : undefined;
    const now = new Date();
    const comingSoon = releaseDate ? releaseDate > now : false;

    // 인기도 계산 (RAWG added 기반)
    const popularityScore =
      typeof raw.popularityScore === 'number'
        ? raw.popularityScore
        : PopularityCalculator.calculateRawgPopularity(raw.added);

    // 출시 상태 판단
    let releaseStatus: ReleaseStatus;
    if (!releaseDate) {
      releaseStatus = ReleaseStatus.TBA;
    } else if (comingSoon) {
      releaseStatus = ReleaseStatus.COMING_SOON;
    } else {
      releaseStatus = ReleaseStatus.RELEASED;
    }

    const meetsPopularityThreshold =
      popularityScore >= RAWG_COLLECTION.popularityThreshold;

    // ===== ✅ RAWG API 상세 정보 조회 (인기도 40점 이상, DLC 아닐 때만) =====
    let rawgDetails: RawgGameDetails | null = null;
    let storeLookup: Partial<Record<ConsoleFamily, StoreInfo>> = {};

    let youtubeVideoUrl: string | undefined;
    let details: ProcessedGameData['details'];
    let releases: ProcessedGameData['releases'];

    if (!raw.isDlc && meetsPopularityThreshold) {
      try {
        rawgDetails = await this.rawgApiService.getGameDetails(raw.rawgId);

        try {
          const trailerResult = await this.youtubeService.findOfficialTrailer(
            raw.name,
          );
          const picked = trailerResult?.picked;

          if (picked?.url) {
            youtubeVideoUrl = picked.url;
            this.logger.debug(
              `✨ [YouTube] 트레일러 발견 - ${raw.name}: ${youtubeVideoUrl}`,
            );
          }
        } catch (youtubeError) {
          this.logger.warn(
            `⚠️ [YouTube] 트레일러 조회 실패 - ${raw.name}: ${youtubeError.message}`,
          );
        }

        if (rawgDetails) {
          const detailStores = rawgDetails.stores ?? null;
          if (detailStores && detailStores.length > 0) {
            storeLookup = this.mapStoresByPlatform(
              detailStores,
              raw,
              consoleIssues,
              false,
            );
          }

          const needsStoreApi = raw.platformFamilies.some(
            (family) => !storeLookup[family],
          );

          if (needsStoreApi) {
            try {
              const stores = await this.rawgApiService.getGameStores(
                raw.rawgId,
              );
              const apiLookup = this.mapStoresByPlatform(
                stores,
                raw,
                consoleIssues,
              );

              for (const family of Object.keys(apiLookup) as ConsoleFamily[]) {
                const apiStore = apiLookup[family];
                if (!apiStore) continue;
                const existing = storeLookup[family];

                if (!existing) {
                  storeLookup[family] = apiStore;
                  continue;
                }

                const hasUrl =
                  existing.storeUrl && existing.storeUrl.length > 0;
                const hasAppId =
                  existing.storeAppId && existing.storeAppId.length > 0;

                storeLookup[family] = {
                  family: existing.family,
                  store: existing.store,
                  storeAppId: hasAppId
                    ? existing.storeAppId
                    : apiStore.storeAppId,
                  storeUrl: hasUrl ? existing.storeUrl : apiStore.storeUrl,
                };
              }
            } catch (error) {
              const message = (error as Error).message;
              consoleIssues.push(
                `[${raw.sourceMonth}] 스토어 조회 실패: ${raw.name} - ${message}`,
              );
              this.logger.warn(
                `⚠️ [RAWG Stores] 조회 실패 - ${raw.name}: ${message}`,
              );
            }
          }

          details = {
            headerImage: raw.headerImage,
            screenshots: raw.screenshots,
            videoUrl: youtubeVideoUrl,
            description:
              rawgDetails.description_raw ??
              rawgDetails.description ??
              undefined,
            sexual: false,
            website: rawgDetails.website || undefined,
            genres: rawgDetails.genres?.map((g: any) => g.name) || [],
            tags: rawgDetails.tags?.slice(0, 10).map((t: any) => t.name) || [],
            supportLanguages: [],
            metacriticScore: rawgDetails.metacritic || undefined,
            opencriticScore: undefined,
            rawgAdded: raw.added,
          };

          releases = raw.platformFamilies.map((family) => {
            const storeInfo = storeLookup[family];
            if (!storeInfo) {
              consoleIssues.push(
                `[${raw.sourceMonth}] 스토어 링크 누락 (${family}) - ${raw.name}`,
              );
            }
            const fallback = this.storeFallbackForFamily(family, raw.name);
            const chosenStore = storeInfo?.store ?? fallback.store;
            const storeUrl = this.pickBestStoreUrl(
              storeInfo?.storeUrl,
              fallback.storeUrl,
              chosenStore,
              raw.name,
            );
            return {
              platform: family as Platform,
              store: storeInfo?.store ?? fallback.store,
              storeAppId:
                storeInfo?.storeAppId?.trim() ??
                `${raw.rawgId}-${family.toLowerCase()}`,
              storeUrl,
              releaseDateDate: releaseDate,
              releaseDateRaw: raw.released ?? undefined,
              releaseStatus,
              comingSoon,
              currentPriceCents: undefined,
              isFree: false,
              followers: undefined,
              reviewsTotal: rawgDetails?.reviews_count || undefined,
              reviewScoreDesc: rawgDetails?.rating
                ? `${rawgDetails.rating}/5`
                : undefined,
              dataSource: 'rawg' as const,
            };
          });
        }
      } catch (error) {
        this.logger.warn(
          `⚠️ [RAWG Details] 상세 정보 조회 실패 - ${raw.name}: ${(error as Error).message}`,
        );
      }
    }

    return {
      name: raw.name,
      ogName: raw.name,
      ogSlug: raw.slug,
      slug: raw.slug,
      rawgId: raw.rawgId,
      gameType: GameType.GAME, // RAWG 데이터는 기본적으로 GAME으로 분류

      // ===== Phase 5.5: DLC 메타데이터 =====
      isDlc: raw.isDlc, // DLC 여부 (parent_games_count > 0 감지)
      parentRawgId: raw.parentRawgId, // 부모 게임 RAWG ID (DLC일 때만 존재)

      releaseDate,
      releaseDateRaw: raw.released ?? undefined,
      releaseStatus,
      comingSoon,
      popularityScore,

      // ===== 회사 정보 (개발사/퍼블리셔) =====
      companies: rawgDetails
        ? [
            ...(rawgDetails.developers || []).map((dev: any) => ({
              name: typeof dev === 'string' ? dev : dev?.name || 'Unknown',
              slug: typeof dev === 'object' && dev?.slug ? dev.slug : undefined, // ✅ RAWG slug 직접 사용
              role: CompanyRole.DEVELOPER,
            })),
            ...(rawgDetails.publishers || []).map((pub: any) => ({
              name: typeof pub === 'string' ? pub : pub?.name || 'Unknown',
              slug: typeof pub === 'object' && pub?.slug ? pub.slug : undefined, // ✅ RAWG slug 직접 사용
              role: CompanyRole.PUBLISHER,
            })),
          ]
        : undefined,

      // ✅ game_detail 전체 필드 포함
      details,

      // ✅ game_release 정보 포함
      releases,
    };
  }

  private mapStoresByPlatform(
    stores: RawgGameStoreResult[],
    raw: RawgIntermediate,
    consoleIssues: string[],
    reportMissing = true,
  ): Partial<Record<ConsoleFamily, StoreInfo>> {
    const map: Partial<Record<ConsoleFamily, StoreInfo>> = {};

    for (const store of stores) {
      const resolved = this.resolveStoreResult(store);
      if (!resolved) continue;
      if (map[resolved.family]) continue;

      map[resolved.family] = {
        family: resolved.family,
        store: resolved.store,
        storeAppId: String(store.id ?? store.store_id ?? raw.rawgId),
        storeUrl: this.normalizeStoreUrl(store.url_en ?? store.url ?? null),
      };
    }

    if (reportMissing) {
      for (const family of raw.platformFamilies) {
        if (!map[family]) {
          consoleIssues.push(
            `[${raw.sourceMonth}] 스토어 응답에 ${family} 항목이 없습니다: ${raw.name}`,
          );
        }
      }
    }

    return map;
  }

  private resolveStoreResult(
    store: RawgGameStoreResult,
  ): { family: ConsoleFamily; store: Store } | null {
    const tokens = [
      store.store?.slug,
      store.store?.name,
      store.store?.domain,
      store.url_en,
      store.url,
    ]
      .map((value) => value?.toLowerCase().trim() ?? '')
      .filter((value) => value.length > 0);
    const combined = tokens.join(' ');
    const storeId = store.store_id ?? 0;

    if (this.isPlayStationStore(combined, storeId)) {
      return { family: 'playstation', store: 'psn' as Store };
    }

    if (this.isXboxStore(combined, storeId)) {
      return { family: 'xbox', store: 'xbox' as Store };
    }

    if (this.isNintendoStore(combined, storeId)) {
      return { family: 'nintendo', store: 'nintendo' as Store };
    }

    return null;
  }

  private storeFallbackForFamily(
    family: ConsoleFamily,
    gameName: string,
  ): { store: Store; storeUrl?: string } {
    switch (family) {
      case 'playstation':
        return {
          store: 'psn' as Store,
          storeUrl: this.buildPlayStationSearchUrl(gameName),
        };
      case 'xbox':
        return {
          store: 'xbox' as Store,
          storeUrl: this.buildXboxSearchUrl(gameName),
        };
      case 'nintendo':
      default:
        return {
          store: 'nintendo' as Store,
          storeUrl: this.buildNintendoSearchUrl(gameName),
        };
    }
  }

  private normalizeStoreUrl(url: string | null): string | null {
    const trimmed = url?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  }

  private pickBestStoreUrl(
    primary: string | null | undefined,
    fallback: string | undefined,
    store: Store,
    gameName: string,
  ): string {
    const normalizedPrimary = primary?.trim();
    if (normalizedPrimary) return normalizedPrimary;

    const normalizedFallback = fallback?.trim();
    if (normalizedFallback) return normalizedFallback;

    const searchUrl = this.buildStoreSearchUrl(store, gameName);
    if (searchUrl) return searchUrl;

    return this.buildXboxSearchUrl(gameName);
  }

  private buildXboxSearchUrl(gameName: string): string {
    const query = encodeURIComponent(gameName);
    return `https://www.xbox.com/ko-kr/Search/Results?q=${query}`;
  }

  private buildPlayStationSearchUrl(gameName: string): string {
    const query = encodeURIComponent(gameName);
    return `https://www.playstation.com/ko-kr/search/?q=${query}&category=games`;
  }

  private buildNintendoSearchUrl(gameName: string): string {
    const query = encodeURIComponent(gameName);
    return `https://www.nintendo.com/kr/search?k=${query}`;
  }

  private buildStoreSearchUrl(store: Store, gameName: string): string | null {
    switch (store) {
      case 'psn':
        return this.buildPlayStationSearchUrl(gameName);
      case 'xbox':
        return this.buildXboxSearchUrl(gameName);
      case 'nintendo':
        return this.buildNintendoSearchUrl(gameName);
      default:
        return null;
    }
  }

  private isPlayStationStore(text: string, storeId: number): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes('playstation') ||
      lower.includes('psn') ||
      lower.includes('sony') ||
      [2, 3].includes(storeId)
    );
  }

  private isXboxStore(text: string, storeId: number): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes('xbox') || lower.includes('microsoft') || storeId === 7
    );
  }

  private isNintendoStore(text: string, storeId: number): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes('nintendo') ||
      lower.includes('eshop') ||
      lower.includes('switch') ||
      storeId === 6
    );
  }

  private async writeReport(report: RawgCollectionReport): Promise<void> {
    try {
      const dir = join(process.cwd(), 'logs', 'rawg');
      await fs.mkdir(dir, { recursive: true });
      const timestamp = report.finishedAt.replace(/[:.]/g, '-');
      const filePath = join(dir, `rawg-${timestamp}.json`);
      await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
    } catch (error) {
      this.logger.warn(
        `⚠️ [RAWG] 리포트 기록 실패: ${(error as Error).message}`,
      );
    }
  }

  private delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
