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
import {
  extractPlatformFamilies,
  normalizePlatformSlug,
} from './utils/platform-normalizer';
import {
  RawgGameDetails,
  RawgGameSearchResult,
  RawgGameStoreResult,
} from './rawg.types';
import { ProcessedGameData, MatchingContextData } from '@pipeline/contracts';
import {
  RawgIntermediate,
  RawgMonthStat,
  RawgRetryLog,
  RawgCollectionReport,
  StoreInfo,
  ConsoleFamily,
  RawgCollectorOptions,
} from './types';
import {
  GameType,
  ReleaseStatus,
  CompanyRole,
  Platform,
  Store,
} from '../entities/enums';
import { PopularityCalculator } from '../common/utils/popularity-calculator.util';
import { rawgMonitor } from './utils/rawg-monitor';

// YouTube 서비스 추가 (Phase 4)
import { YouTubeService } from '../youtube/youtube.service';
import { normalizeGameName } from '../common/utils/game-name-normalizer.util';
import { normalizeGameName as buildMatchingName } from '../common/matching';
import { normalizeSlugCandidate } from '../common/slug/slug-normalizer.util';
import {
  buildSlugVariantsFromName,
  detectDuplicateSlugBase,
} from '../common/slug/slug-variant.util';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Game } from '../entities/game.entity';

type MonthTuple = [number, number];

interface RawgMonthlyRangeOptions {
  startMonth?: string;
  endMonth?: string;
  monthsBack?: number;
  monthsForward?: number;
  limitMonths?: number;
  ordering?: '-released' | '-added';
  metacritic?: string;
  pageSize?: number;
  excludeExisting?: boolean;
  dryRun?: boolean;
}

interface RawgCollectByIdOptions {
  chunkSize?: number;
  delayMs?: number;
  dryRun?: boolean;
}

interface RawgCollectAllOptions extends RawgCollectByIdOptions {
  limit?: number;
}

@Injectable()
export class RawgDataPipelineService {
  private readonly logger = new Logger(RawgDataPipelineService.name);
  private lastReport: RawgCollectionReport | null = null;

  constructor(
    private readonly rawgApiService: RawgApiService,
    private readonly youtubeService: YouTubeService, // Phase 4: YouTube 서비스 주입
    @InjectRepository(Game)
    private readonly gamesRepository: Repository<Game>,
  ) {}

  getLatestReport(): RawgCollectionReport | null {
    return this.lastReport;
  }

  /**
   * ✅ 공개 API 이름 유지: collectProcessedData()
   * 내부적으로 collectMonthlyRange를 호출하며, 향후 호환성을 위해 유지한다.
   */
  async collectProcessedData(
    opts: RawgCollectorOptions = {},
  ): Promise<ProcessedGameData[]> {
    return this.collectMonthlyRange({
      monthsBack: opts.monthsBack ?? RAWG_COLLECTION.pastMonths,
      monthsForward: opts.monthsForward ?? RAWG_COLLECTION.futureMonths,
      limitMonths: opts.limitMonths,
      ordering: opts.ordering,
      metacritic: opts.metacritic,
      excludeExisting: false,
    });
  }

  /**
   * 월 범위 기반 RAWG 수집 (신규/갱신 공통)
   */
  async collectMonthlyRange(
    options: RawgMonthlyRangeOptions = {},
  ): Promise<ProcessedGameData[]> {
    const startedAt = Date.now();
    const months = this.buildMonthSequence(options);
    if (!months.length) {
      this.logger.warn('⚠️ [RAWG] 선택된 월이 없어 수집을 건너뜁니다.');
      this.lastReport = {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        totalGames: 0,
        months: [],
        failedMonths: [],
        retryLogs: [],
        consoleIssues: [],
        monitorSnapshot: rawgMonitor.snapshot(),
      };
      return [];
    }

    const ordering = options.ordering ?? RAWG_COLLECTION.ordering;
    const metacritic = options.metacritic;
    const pageSize = options.pageSize ?? RAWG_COLLECTION.pageSize;
    const excludeExisting = options.excludeExisting ?? false;

    this.logger.log(
      `🗓️ [RAWG] 월 범위 수집 시작 — 총 ${months.length}개월 (excludeExisting=${excludeExisting})`,
    );

    const queue = months.map(([year, month]) => ({
      year,
      month,
      attempt: 1,
    }));
    const maxAttempts = 3;

    const seen = new Set<number>();
    const existingIds = excludeExisting
      ? await this.loadExistingRawgIds()
      : new Set<number>();

    const platformIds: number[] = [];
    if (RAWG_COLLECTION.enablePcPlatform) {
      platformIds.push(...RAWG_PLATFORM_IDS.pc);
    }
    platformIds.push(
      ...RAWG_PLATFORM_IDS.playstation,
      ...RAWG_PLATFORM_IDS.xbox,
      ...RAWG_PLATFORM_IDS.nintendo,
    );
    const unifiedPlatforms = platformIds.join(',');

    const processedData: ProcessedGameData[] = [];
    let totalCollected = 0;
    const monthStats: RawgMonthStat[] = [];
    const retryLogs: RawgRetryLog[] = [];
    const failedMonths: string[] = [];
    const consoleIssues: string[] = [];
    let monthIndex = 0;
    const shouldStop = false;

    while (queue.length && !shouldStop) {
      const task = queue.shift()!;
      monthIndex++;
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
        params.page_size = pageSize;

        stat.requestCount += 1;
        this.logger.log(
          `📅 [RAWG] (${monthIndex}/${months.length}) ${monthKey} 수집 시작 (attempt ${task.attempt})`,
        );

        const games = await this.rawgApiService.searchGamesByPlatformPaged({
          platforms: unifiedPlatforms,
          dates: params.dates,
          ordering: params.ordering,
          metacritic: params.metacritic,
          pageSize,
          maxPages: 10,
        });

        if (!games) {
          retryReason = 'api_error';
          throw new Error('RAWG API 응답 없음');
        }

        if (!games.length) {
          stat.success = true;
          stat.reason = 'empty_result';
          this.logger.log(
            `➖ [RAWG] ${monthKey} 결과 없음 (0) — 다음 달로 이동`,
          );
          continue;
        }

        const monthRawResults: RawgIntermediate[] = [];
        let addedCount = 0;
        let skippedByAdded = 0;
        let skippedByPopularity = 0;
        let skippedExisting = 0;

        for (const g of games) {
          if (shouldStop) break;
          const rawgId = g?.id;
          if (!rawgId || seen.has(rawgId)) continue;
          if (excludeExisting && existingIds.has(rawgId)) {
            skippedExisting++;
            continue;
          }

          const added = typeof g.added === 'number' ? g.added : 0;
          if (added < RAWG_COLLECTION.minAdded) {
            this.pushIssue(
              consoleIssues,
              `[${monthKey}] added(${added}) < ${RAWG_COLLECTION.minAdded} → 스킵: ${g.name}`,
            );
            skippedByAdded++;
            continue;
          }

          const popularityScore =
            PopularityCalculator.calculateRawgPopularity(added);
          if (popularityScore < RAWG_COLLECTION.popularityThreshold) {
            skippedByPopularity++;
            continue;
          }

          const families = Array.from(
            new Set(extractPlatformFamilies(g.platforms || [])),
          ) as ConsoleFamily[];
          if (!families.length) {
            this.pushIssue(
              consoleIssues,
              `[${monthKey}] 플랫폼 정보를 찾지 못했습니다: ${g.name}`,
            );
            continue;
          }

          let isDlc = false;
          let parentRawgId: number | undefined;
          const parentCount = Number(
            g.parent_games_count ?? g.parents_count ?? 0,
          );
          if (parentCount > 0) {
            try {
              const parentGames =
                await this.rawgApiService.getParentGames(rawgId);
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

          const normalizedSlug = normalizeGameName(g.name);
          const platformDetails = (g.platforms || []).map((p: any) => ({
            slug: p?.platform?.slug ?? undefined,
            releasedAt: p?.released_at ?? null,
          }));

          monthRawResults.push({
            rawgId,
            slug: normalizedSlug,
            name: g.name,
            parentRawgId,
            screenshots: (g.short_screenshots || [])
              .slice(0, 5)
              .map((s: any) => s.image),
            headerImage: g.background_image ?? null,
            released: g.released ?? null,
            platformFamilies: families,
            platformDetails,
            added,
            popularityScore,
            isDlc,
            sourceMonth: monthKey,
          });
          seen.add(rawgId);
          addedCount++;
        }
        stat.gameCount = addedCount;
        stat.success = true;
        stat.reason = `ok(len=${games.length}, kept=${addedCount}, skipAdded=${skippedByAdded}, skipPop=${skippedByPopularity}, skipExisting=${skippedExisting})`;
        totalCollected += addedCount;

        if (monthRawResults.length) {
          const mapped = await this.mapRawResults(
            monthRawResults,
            consoleIssues,
            processedData.length,
          );
          processedData.push(...mapped);
        }

        this.logger.log(
          `✅ [RAWG] ${monthKey} 완료 — 총:${games.length}, 저장:${addedCount}, added필터:${skippedByAdded}, 인기필터:${skippedByPopularity}, 기존:${skippedExisting}`,
        );
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
        } else if (!shouldStop) {
          const baseDelay =
            RAWG_COLLECTION.requestDelayMs * (task.attempt > 1 ? 1.5 : 1);
          await this.delay(baseDelay);
        }
      }
    }

    this.logger.log(
      `✨ [RAWG] 월 단위 수집 종료 — 후보 ${totalCollected}건, 상세 완료 ${processedData.length}건`,
    );

    const report: RawgCollectionReport = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      totalGames: processedData.length,
      months: monthStats,
      failedMonths,
      retryLogs,
      consoleIssues: Array.from(new Set(consoleIssues)),
      monitorSnapshot: rawgMonitor.snapshot(),
    };

    this.lastReport = report;
    await this.writeReport(report);

    return processedData;
  }

  async collectNewGames(
    options: RawgMonthlyRangeOptions = {},
  ): Promise<ProcessedGameData[]> {
    return this.collectMonthlyRange({
      ...options,
      excludeExisting: options.excludeExisting ?? true,
    });
  }

  async collectByRawgIds(
    rawgIds: number[],
    opts: RawgCollectByIdOptions = {},
  ): Promise<ProcessedGameData[]> {
    const startedAt = Date.now();
    const chunkSize = Math.max(1, opts.chunkSize ?? 20);
    const delayMs = Math.max(0, opts.delayMs ?? 1000);

    if (!Array.isArray(rawgIds) || rawgIds.length === 0) {
      this.logger.warn('[RAWG] collectByRawgIds 호출 - 대상 ID가 없습니다.');
      this.lastReport = {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        totalGames: 0,
        months: [],
        failedMonths: [],
        retryLogs: [],
        consoleIssues: [],
        monitorSnapshot: rawgMonitor.snapshot(),
      };
      return [];
    }

    const consoleIssues: string[] = [];
    const results: ProcessedGameData[] = [];
    const retryLogs: RawgRetryLog[] = [];

    for (let index = 0; index < rawgIds.length; index += chunkSize) {
      const slice = rawgIds.slice(index, index + chunkSize);
      this.logger.log(
        `🎯 [RAWG] RAWG ID 갱신 (${index + 1}-${index + slice.length}/${rawgIds.length})`,
      );

      for (const id of slice) {
        try {
          const processed = await this.collectOneByRawgId(id);
          if (processed) {
            results.push(processed);
          } else {
            retryLogs.push({
              month: `rawg:${id}`,
              attempts: 1,
              status: 'failed',
              reason: 'not-found',
            });
          }
        } catch (error: any) {
          retryLogs.push({
            month: `rawg:${id}`,
            attempts: 1,
            status: 'failed',
            reason: error?.message ?? 'unknown-error',
          });
        }
      }

      if (delayMs > 0 && index + chunkSize < rawgIds.length) {
        await this.delay(delayMs);
      }
    }

    this.lastReport = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      totalGames: results.length,
      months: [],
      failedMonths: retryLogs
        .filter((log) => log.status === 'failed')
        .map((log) => log.month),
      retryLogs,
      consoleIssues: Array.from(new Set(consoleIssues)),
      monitorSnapshot: rawgMonitor.snapshot(),
    };

    return results;
  }

  async collectAllExisting(
    opts: RawgCollectAllOptions = {},
  ): Promise<{ targetIds: number[]; processed: ProcessedGameData[] }> {
    const qb = this.gamesRepository
      .createQueryBuilder('game')
      .select('game.rawg_id', 'rawg_id')
      .where('game.rawg_id IS NOT NULL')
      .orderBy('game.updated_at', 'DESC');

    if (opts.limit && opts.limit > 0) {
      qb.limit(opts.limit);
    }

    const rows = await qb.getRawMany<{ rawg_id: string }>();
    const ids = rows
      .map((row) => Number(row.rawg_id))
      .filter((id) => Number.isFinite(id) && id > 0);

    const processed = await this.collectByRawgIds(ids, opts);
    return { targetIds: ids, processed };
  }

  /**
   * RAWG 단일 수집 (rawg_id 기준)
   * - 성공: 해당 게임을 ProcessedGameData로 가공하여 반환
   * - 미존재/실패: null
   */
  async collectOneByRawgId(rawgId: number): Promise<ProcessedGameData | null> {
    if (!Number.isFinite(rawgId) || rawgId <= 0) {
      this.logger.warn(`[RAWG:one] 잘못된 rawgId: ${rawgId}`);
      return null;
    }

    const consoleIssues: string[] = [];

    try {
      // 1) 상세 조회
      const details = await this.rawgApiService.getGameDetails(rawgId);
      if (!details) {
        this.logger.warn(`[RAWG:one] 게임을 찾을 수 없음 - rawgId=${rawgId}`);
        return null;
      }

      // 2) 플랫폼 패밀리 계산
      const families = Array.from(
        new Set(extractPlatformFamilies(details.platforms || [])),
      ) as ConsoleFamily[];

      if (!families.length) {
        this.pushIssue(
          consoleIssues,
          `[manual] 플랫폼 정보를 찾지 못했습니다: ${details.name}`,
        );
        this.logger.warn(
          `⚠️ [RAWG:one] 플랫폼 정보 없음 - ${details.name} (rawgId=${rawgId})`,
        );
      }

      // 3) DLC/부모 매핑
      let isDlc = false;
      let parentRawgId: number | undefined;
      const parentCount =
        Number(details?.parent_games_count ?? details?.parents_count ?? 0) || 0;
      if (parentCount > 0) {
        try {
          const parents = await this.rawgApiService.getParentGames(rawgId);
          if (parents?.length > 0) {
            isDlc = true;
            parentRawgId = parents[0].id;
            this.logger.log(
              `✅ [RAWG:one] DLC 확정 - ${details.name} → 부모: ${parents[0].name} (rawg_id: ${parentRawgId})`,
            );
          }
        } catch (e) {
          this.logger.warn(
            `⚠️ [RAWG:one] 부모 게임 조회 실패 - ${details.name}: ${(e as Error).message}`,
          );
        }
      }

      // 4) RawgIntermediate 구성
      const added =
        typeof (details as any)?.added === 'number'
          ? (details as any).added
          : 0;

      const platformDetails = (details.platforms || []).map((p: any) => ({
        slug: p?.platform?.slug ?? undefined,
        releasedAt: p?.released_at ?? null,
      }));

      const intermediate: RawgIntermediate = {
        rawgId,
        slug: normalizeGameName(details.name) ?? undefined,
        name: details.name,
        headerImage: (details as any)?.background_image ?? '',
        screenshots:
          (details as any)?.short_screenshots
            ?.slice(0, 5)
            .map((s: any) => s.image) ?? [],
        released: (details as any)?.released ?? null,
        platformFamilies: families,
        platformDetails,
        added,
        popularityScore: PopularityCalculator.calculateRawgPopularity(added),
        isDlc,
        parentRawgId,
        sourceMonth: 'manual',
      };

      // 5) 최종 매핑 (mapToProcessedGameData 내부에서 디테일/스토어/유튜브 추가 조회 수행)
      const processed = await this.mapToProcessedGameData(
        intermediate,
        consoleIssues,
      );

      return processed ?? null;
    } catch (err: any) {
      // 필요 시 레이트 리밋/404 등 세분화
      if (err?.status === 404) {
        this.logger.warn(`[RAWG:one] 404 Not Found - rawgId=${rawgId}`);
        return null;
      }
      this.logger.error(
        `[RAWG:one] 수집 실패 - rawgId=${rawgId} - ${err?.message ?? err}`,
      );
      throw err; // 상위에서 공통 에러 처리(재시도/실패 집계)
    }
  }

  private buildMonthSequence(options: RawgMonthlyRangeOptions): MonthTuple[] {
    const limitMonths =
      options.limitMonths && options.limitMonths > 0
        ? Math.floor(options.limitMonths)
        : undefined;

    let sequence: MonthTuple[] = [];

    if (options.startMonth || options.endMonth) {
      const start = this.parseMonthString(
        options.startMonth ?? options.endMonth!,
      );
      const end = this.parseMonthString(
        options.endMonth ?? options.startMonth!,
      );
      const [startYear, startMonth] = start;
      const [endYear, endMonth] = end;
      let currentYear = startYear;
      let currentMonth = startMonth;

      while (
        currentYear < endYear ||
        (currentYear === endYear && currentMonth <= endMonth)
      ) {
        sequence.push([currentYear, currentMonth]);
        currentMonth++;
        if (currentMonth > 12) {
          currentMonth = 1;
          currentYear++;
        }
      }
    } else {
      const past = options.monthsBack ?? RAWG_COLLECTION.pastMonths;
      const future = options.monthsForward ?? RAWG_COLLECTION.futureMonths;
      sequence = generateMonthRange(past, future);
    }

    if (limitMonths) {
      sequence = sequence.slice(0, limitMonths);
    }

    return sequence;
  }

  private parseMonthString(value: string): MonthTuple {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match) {
      throw new Error(`잘못된 월 형식(YYYY-MM): ${value}`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      month < 1 ||
      month > 12
    ) {
      throw new Error(`잘못된 월 값: ${value}`);
    }
    return [year, month];
  }

  private async loadExistingRawgIds(): Promise<Set<number>> {
    const rows = await this.gamesRepository
      .createQueryBuilder('game')
      .select('game.rawg_id', 'rawg_id')
      .where('game.rawg_id IS NOT NULL')
      .getRawMany<{ rawg_id: string }>();
    const set = new Set<number>();
    for (const row of rows) {
      const id = Number(row.rawg_id);
      if (Number.isFinite(id) && id > 0) {
        set.add(id);
      }
    }
    return set;
  }

  private async mapRawResults(
    rawResults: RawgIntermediate[],
    consoleIssues: string[],
    offset = 0,
  ): Promise<ProcessedGameData[]> {
    const processedData: ProcessedGameData[] = [];
    const chunkCount = rawResults.length;
    const globalTotal = offset + chunkCount;
    this.logger.log(
      `🧪 [RAWG] 게임 메타 매핑 시작 — 이번 청크 ${chunkCount}건 (누적 ${globalTotal}건)`,
    );
    for (let i = 0; i < rawResults.length; i++) {
      const raw = rawResults[i];
      const globalIndex = offset + i + 1;
      const logPrefix = `[${globalIndex}/${globalTotal}] ${raw.name} (rawgId=${raw.rawgId}, month=${raw.sourceMonth})`;
      if (i === 0 || (i + 1) % 25 === 0 || i === rawResults.length - 1) {
        this.logger.log(`🔧 [RAWG] 매핑 진행 ${logPrefix}`);
      }

      this.logger.debug(`🎯 [RAWG] 상세 매핑 시작 — ${logPrefix}`);
      try {
        const gameData = await this.mapToProcessedGameData(raw, consoleIssues);
        processedData.push(gameData);
        this.logger.debug(`✅ [RAWG] 상세 매핑 완료 — ${logPrefix}`);
      } catch (error: any) {
        this.logger.error(
          `❌ [RAWG] 상세 매핑 실패 — ${logPrefix}: ${error?.message ?? error}`,
        );
        throw error;
      }
    }
    this.logger.log(
      `✅ [RAWG] 게임 메타 매핑 완료 — ${processedData.length}건`,
    );
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
    const releaseInfo = this.selectBestReleaseDate(raw);
    const releaseDate = releaseInfo.date;
    const comingSoon = releaseInfo.comingSoon;
    const normalizedForMatching = buildMatchingName(raw.name);

    // 인기도 계산 (RAWG added 기반)
    const popularityScore =
      typeof raw.popularityScore === 'number'
        ? raw.popularityScore
        : PopularityCalculator.calculateRawgPopularity(raw.added);

    // 출시 상태 판단
    const releaseStatus = releaseInfo.status;

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

        const detailParentCount = Number(
          rawgDetails?.parent_games_count ?? rawgDetails?.parents_count ?? 0,
        );
        if (detailParentCount > 0) {
          if (!raw.isDlc) {
            raw.isDlc = true;
            this.logger.log(
              `✅ [RAWG] 상세 정보에서 DLC 판정 - ${raw.name} (rawgId=${raw.rawgId})`,
            );
          }
          if (!raw.parentRawgId) {
            try {
              const parents = await this.rawgApiService.getParentGames(
                raw.rawgId,
              );
              if (parents?.length) {
                raw.parentRawgId = parents[0].id;
                this.logger.log(
                  `   ↳ 부모 게임: ${parents[0].name} (rawg_id=${parents[0].id})`,
                );
              }
            } catch (e: any) {
              this.logger.warn(
                `⚠️ [RAWG] 상세 기반 부모 조회 실패 - ${raw.name}: ${e?.message ?? e}`,
              );
            }
          }
        }

        try {
          const releaseYear = releaseDate?.getUTCFullYear();
          const developerNames = Array.isArray(rawgDetails?.developers)
            ? rawgDetails.developers
                .map((dev: any) =>
                  typeof dev === 'string' ? dev : (dev?.name ?? ''),
                )
                .filter((name: string) => name && name.length <= 60)
            : [];
          const publisherNames = Array.isArray(rawgDetails?.publishers)
            ? rawgDetails.publishers
                .map((pub: any) =>
                  typeof pub === 'string' ? pub : (pub?.name ?? ''),
                )
                .filter((name: string) => name && name.length <= 60)
            : [];
          const youtubeKeywords = Array.from(
            new Set([...developerNames, ...publisherNames]),
          ).slice(0, 6);

          const trailerResult = await this.youtubeService.findOfficialTrailer(
            raw.name,
            {
              releaseYear,
              releaseDate,
              keywords: youtubeKeywords,
            },
          );
          const picked = trailerResult?.picked;

          if (picked?.url) {
            const youtubeDuration = picked.durationSeconds ?? null;
            const acceptable =
              this.youtubeService.isDurationAcceptable(youtubeDuration);
            if (acceptable) {
              youtubeVideoUrl = picked.url;
              this.logger.debug(
                `✨ [YouTube] 트레일러 선택 - ${raw.name}: ${youtubeVideoUrl} (confidence=${picked.confidence}, score=${picked.score.toFixed(3)}, views=${picked.viewCount ?? 'n/a'})`,
              );
            } else {
              // this.logger.debug(
              //   `⏭️ [YouTube] 길이 조건 불만족(${youtubeDuration ?? 'unknown'}s) → 스킵: ${picked.url}`,
              // );
            }
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
              this.pushIssue(
                consoleIssues,
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
            const platformInfo = raw.platformDetails.find((info) => {
              if (!info.slug) return false;
              const normalized = normalizePlatformSlug(info.slug);
              return normalized === family;
            });
            const platformRaw =
              platformInfo?.releasedAt ?? raw.released ?? undefined;
            const platformDate = platformRaw
              ? (this.safeParseDate(platformRaw) ?? releaseDate)
              : releaseDate;
            if (!storeInfo) {
              this.pushIssue(
                consoleIssues,
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
              releaseDateDate: platformDate ?? undefined,
              releaseDateRaw: platformRaw,
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

    const gameType = raw.isDlc ? GameType.DLC : GameType.GAME;

    const companies = rawgDetails
      ? [
          ...(rawgDetails.developers || []).map((dev: any) => ({
            name: typeof dev === 'string' ? dev : dev?.name || 'Unknown',
            slug: typeof dev === 'object' && dev?.slug ? dev.slug : undefined,
            role: CompanyRole.DEVELOPER,
          })),
          ...(rawgDetails.publishers || []).map((pub: any) => ({
            name: typeof pub === 'string' ? pub : pub?.name || 'Unknown',
            slug: typeof pub === 'object' && pub?.slug ? pub.slug : undefined,
            role: CompanyRole.PUBLISHER,
          })),
        ]
      : undefined;

    const candidateSlugs = new Set<string>();
    const pushCandidate = (value?: string | null) => {
      const normalized = normalizeSlugCandidate(value);
      if (normalized) candidateSlugs.add(normalized);
    };

    pushCandidate(raw.slug);
    pushCandidate(raw.name);
    pushCandidate(rawgDetails?.slug);
    pushCandidate(rawgDetails?.name);

    buildSlugVariantsFromName(raw.name).forEach(pushCandidate);
    if (rawgDetails?.name && rawgDetails.name !== raw.name) {
      buildSlugVariantsFromName(rawgDetails.name).forEach(pushCandidate);
    }

    const duplicateBase = detectDuplicateSlugBase(raw.slug, raw.name);
    if (duplicateBase) candidateSlugs.add(duplicateBase);

    const matchingContext: MatchingContextData = {
      source: 'rawg',
      normalizedName: {
        lowercase: normalizedForMatching.lowercase,
        tokens: normalizedForMatching.tokens,
        compact: normalizedForMatching.compact,
        looseSlug: normalizedForMatching.looseSlug,
      },
      releaseDateIso: releaseDate
        ? releaseDate.toISOString().slice(0, 10)
        : (releaseInfo.raw ?? null),
      companySlugs: companies
        ?.map((company) => company.slug)
        .filter((slug): slug is string => Boolean(slug)),
      genreTokens: details?.genres?.map((genre) =>
        genre.normalize('NFKC').toLowerCase(),
      ),
      candidateSlugs: candidateSlugs.size ? [...candidateSlugs] : undefined,
    };

    return {
      name: raw.name,
      ogName: raw.name,
      ogSlug: raw.slug,
      slug: raw.slug,
      rawgId: raw.rawgId,
      gameType,
      parentRawgId: raw.isDlc ? raw.parentRawgId : undefined,
      sourceMonth: raw.sourceMonth,

      releaseDate,
      releaseDateRaw: releaseInfo.raw,
      releaseStatus,
      comingSoon,
      popularityScore,

      // ===== 회사 정보 (개발사/퍼블리셔) =====
      companies,

      // ✅ game_detail 전체 필드 포함
      details,

      // ✅ game_release 정보 포함
      releases,

      matchingContext,
    };
  }

  private pushIssue(target: string[], message: string): void {
    if (!message) return;
    if (!target.includes(message)) {
      target.push(message);
    }
  }

  private safeParseDate(value?: string | null): Date | null {
    if (!value) return null;
    const normalized = value.split('T')[0];
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private selectBestReleaseDate(raw: RawgIntermediate): {
    date: Date | undefined;
    raw: string | undefined;
    status: ReleaseStatus;
    comingSoon: boolean;
  } {
    const candidates: { raw: string; date: Date }[] = [];
    const addCandidate = (value?: string | null) => {
      if (!value) return;
      const normalized = value.split('T')[0];
      const parsed = this.safeParseDate(normalized);
      if (parsed) {
        candidates.push({ raw: normalized, date: parsed });
      }
    };

    const pcDetail = raw.platformDetails?.find((info) => {
      if (!info.slug) return false;
      return normalizePlatformSlug(info.slug) === 'pc';
    });
    if (pcDetail?.releasedAt) {
      addCandidate(pcDetail.releasedAt);
    }

    raw.platformDetails?.forEach((info) => addCandidate(info.releasedAt));
    addCandidate(raw.released);

    if (candidates.length === 0) {
      return {
        date: undefined,
        raw: undefined,
        status: ReleaseStatus.TBA,
        comingSoon: false,
      };
    }

    candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
    const chosen = candidates[0];
    const now = new Date();
    const comingSoon = chosen.date > now;
    const status = comingSoon
      ? ReleaseStatus.COMING_SOON
      : ReleaseStatus.RELEASED;

    return {
      date: chosen.date,
      raw: chosen.raw,
      status,
      comingSoon,
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
          this.pushIssue(
            consoleIssues,
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
      case 'pc':
        return {
          store: Store.STEAM,
          storeUrl: `https://store.steampowered.com/search/?term=${encodeURIComponent(gameName)}`,
        };
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
