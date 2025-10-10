import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

// 엔티티
import { Game, GameDetail, GameRelease, DataSyncStatus } from '../../entities';
import {
  GameType,
  Platform,
  Store,
  ReleaseStatus,
  SteamReleaseDateRaw,
  CompanyRole,
} from '../../entities/enums';

// 서비스
import { SteamAppListService } from './steam-applist.service';
import { SteamAppDetailsService } from './steam-appdetails.service';
import { SteamCommunityService } from './steam-community.service';
import { SteamReviewService } from './steam-review.service';
// 타입
import {
  ProcessedGameData,
  SteamCollectOptions,
  PrioritySelectionOptions,
  ExistingGamesMap,
  SteamRefreshCandidate,
} from '@pipeline/contracts';
import { SteamApp } from './steam-applist.service';

// 유틸
import { PopularityCalculator } from '../../common/utils/popularity-calculator.util';
import { normalizeGameName } from '../../common/utils/game-name-normalizer.util';
// YouTube 서비스 추가 (Phase 4)
import { YouTubeService } from '../../youtube/youtube.service';

import { runWithConcurrency } from '../../common/concurrency/promise-pool.util';
import { getGlobalRateLimiter } from '../../common/concurrency/global-rate-limiter';
import { RateLimitExceededError } from '../../common/concurrency/rate-limit-monitor';
import { ExistingGamesSnapshotService } from '../../pipeline/persistence/services/existing-games-snapshot.service';

/**
 * Steam 데이터 파이프라인 서비스
 * FINAL-ARCHITECTURE-DESIGN Phase 1 구현
 *
 * 역할: Steam 통합 데이터 수집 + 팔로워 갱신 + 인기도 계산 + YouTube 트레일러
 * 스케줄: 매주 화요일 오전 2시 실행 (주간 5000개 처리)
 */
@Injectable()
export class SteamDataPipelineService {
  private readonly logger = new Logger(SteamDataPipelineService.name);
  private readonly globalLimiter = getGlobalRateLimiter();
  private readonly processingConcurrency = Math.max(
    1,
    Number(process.env.STEAM_PIPELINE_CONCURRENCY ?? '4'),
  );

  // AppList 캐시 (Phase 3 선행 구현)
  private appListCache: {
    fetchedAt: number;
    checksum: string;
    apps: SteamApp[];
  } | null = null;

  constructor(
    @InjectRepository(Game)
    private readonly gameRepository: Repository<Game>,

    @InjectRepository(GameDetail)
    private readonly gameDetailRepository: Repository<GameDetail>,

    @InjectRepository(GameRelease)
    private readonly gameReleaseRepository: Repository<GameRelease>,

    @InjectRepository(DataSyncStatus)
    private readonly dataSyncStatusRepository: Repository<DataSyncStatus>,

    private readonly steamAppListService: SteamAppListService,
    private readonly steamAppDetailsService: SteamAppDetailsService,
    private readonly steamCommunityService: SteamCommunityService,
    private readonly steamReviewService: SteamReviewService,
    private readonly youtubeService: YouTubeService, // Phase 4: YouTube 서비스 주입
    private readonly existingGamesSnapshotService: ExistingGamesSnapshotService,
  ) {}

  private async buildProcessedGameDataFromApp(
    app: SteamApp,
    context?: { index: number; total: number },
  ): Promise<ProcessedGameData | null> {
    const prefix = context
      ? `[${(context.index + 1).toLocaleString()}/${context.total.toLocaleString()}] `
      : '';
    try {
      const timers: { [key: string]: number } = {};

      timers.appDetailsStart = Date.now();
      await this.globalLimiter.take('steam:details');
      const steamDetails = await this.steamAppDetailsService.fetchAppDetails(
        app.appid,
      );
      const displayName =
        typeof steamDetails?.name === 'string' && steamDetails.name.trim()
          ? steamDetails.name.trim()
          : app.name;

      timers.appDetailsDuration = Date.now() - timers.appDetailsStart;
      this.logger.debug(
        `${prefix}⏱️ AppDetails ${(timers.appDetailsDuration / 1000).toFixed(2)}초`,
      );

      if (!steamDetails) {
        this.logger.debug(`${prefix}⚠️ AppDetails 없음 → 스킵: ${app.name}`);
        return null;
      }

      const slugCandidate = normalizeGameName(steamDetails.name, app.appid);
      const ogSlugCandidate = normalizeGameName(app.name, app.appid);
      timers.followersStart = Date.now();
      await this.globalLimiter.take('steam:followers', {
        minDelayMs: 120,
        jitterMs: 80,
      });
      const followers = await this.steamCommunityService.scrapeFollowers(
        app.appid,
        app.name,
      );
      timers.followersDuration = Date.now() - timers.followersStart;
      this.logger.debug(
        `${prefix}⏱️ Followers ${(timers.followersDuration / 1000).toFixed(2)}초 (${followers || 0}명)`,
      );

      let totalReviews = 0;
      let reviewScoreDesc = '';
      let youtubeVideoUrl: string | undefined;
      const popularityScore = PopularityCalculator.calculateSteamPopularity(
        followers || 0,
      );

      const hasKorean =
        Array.isArray(steamDetails.supported_languages) &&
        steamDetails.supported_languages.includes('한국어');
      this.logger.debug(
        `${prefix}📊 인기도 점수: ${popularityScore}점 (한국어 지원)`,
      );
      if (popularityScore >= 40) {
        try {
          await this.globalLimiter.take('steam:reviews', {
            minDelayMs: 100,
            jitterMs: 50,
          });
          const result = await this.steamReviewService.fetchAppReview(
            app.appid,
          );
          totalReviews = result?.total_reviews || 0;
          reviewScoreDesc = result?.review_score_desc || '';
        } catch (error) {
          this.logger.warn(
            `${prefix}⚠️ Review 수집 실패: ${error?.message ?? error}`,
          );
        }
      }

      if (popularityScore >= 40) {
        timers.youtubeStart = Date.now();
        try {
          await this.globalLimiter.take('steam:youtube', {
            minDelayMs: 80,
            jitterMs: 40,
          });
          const trailerResult = await this.youtubeService.findOfficialTrailer(
            app.name,
          );
          const picked = trailerResult?.picked;
          if (picked?.url) {
            youtubeVideoUrl = picked.url;
          }
          timers.youtubeDuration = Date.now() - timers.youtubeStart;
          this.logger.debug(
            `${prefix}⏱️ YouTube ${(timers.youtubeDuration / 1000).toFixed(2)}초`,
          );
        } catch (error) {
          timers.youtubeDuration = Date.now() - timers.youtubeStart;
          this.logger.warn(
            `${prefix}⚠️ YouTube 실패 (${(timers.youtubeDuration / 1000).toFixed(2)}초): ${error?.message ?? error}`,
          );
        }
      } else {
        this.logger.debug(
          `${prefix}⏭️ YouTube 스킵 (인기도 ${popularityScore}점 < 40점)`,
        );
      }

      const isDlcType = steamDetails.type?.toLowerCase() === 'dlc';
      let parentSteamId: number | undefined;
      if (steamDetails.fullgame.appid) {
        const appidRaw = steamDetails.fullgame.appid;
        const appidNum =
          typeof appidRaw === 'string' ? Number(appidRaw) : appidRaw;
        parentSteamId = !Number.isNaN(appidNum) ? appidNum : undefined;
      }

      const isDlc = isDlcType && !!parentSteamId;
      const gameType = isDlc ? GameType.DLC : GameType.GAME;
      if (isDlcType && !parentSteamId) {
        this.logger.warn(
          `${prefix}⚠️ [DLC 부모 없음] ${app.name} - 본편으로 저장`,
        );
      }

      const childDlcSteamIds = !isDlc
        ? ((steamDetails as any).dlc as number[]) || undefined
        : undefined;

      if (isDlc) {
        this.logger.debug(
          `${prefix}🎯 [DLC 감지] ${app.name} → 부모 Steam ID: ${parentSteamId}`,
        );
      } else if (childDlcSteamIds && childDlcSteamIds.length > 0) {
        this.logger.debug(
          `${prefix}📦 [본편] ${app.name} → DLC ${childDlcSteamIds.length}개 발견`,
        );
      }

      const parsed = parseSteamRelease(steamDetails?.release_date);

      const releaseDate = parsed.releaseDate;
      const releaseDateRaw = parsed.releaseDateRaw;
      const releaseStatus = parsed.releaseStatus;

      const processedGame: ProcessedGameData = {
        name: steamDetails.name || app.name,
        slug: slugCandidate ?? undefined,
        ogName: app.name,
        ogSlug: ogSlugCandidate ?? undefined,
        steamId: app.appid,
        rawgId: undefined,
        gameType,
        parentSteamId,
        parentRawgId: undefined,
        parentReferenceType: undefined,
        childDlcSteamIds,
        releaseDate,
        releaseDateRaw,
        releaseStatus,
        comingSoon: steamDetails.coming_soon,
        popularityScore,
        followersCache: followers ?? undefined,
        companies: [
          ...(steamDetails.developers || []).map((dev: any) => ({
            name: typeof dev === 'string' ? dev : dev?.name || 'Unknown',
            role: CompanyRole.DEVELOPER,
          })),
          ...(steamDetails.publishers || []).map((pub: any) => ({
            name: typeof pub === 'string' ? pub : pub?.name || 'Unknown',
            role: CompanyRole.PUBLISHER,
          })),
        ],
        details:
          popularityScore >= 40
            ? {
                screenshots:
                  (steamDetails.screenshots as any[])?.slice(0, 5) || [],
                videoUrl:
                  youtubeVideoUrl ||
                  (steamDetails.movies as any[])?.[0]?.mp4?.max,
                description:
                  (steamDetails.detailed_description as string) || undefined,
                website: (steamDetails.website as string) || undefined,
                genres: (steamDetails.genres as any[]) || [],
                tags: steamDetails.categories || null,
                supportLanguages: steamDetails.supported_languages || [],
                metacriticScore: steamDetails.metacritic || null,
                totalReviews,
                sexual: steamDetails.sexual || false,
                reviewScoreDesc,

                headerImage: steamDetails.header_image,
              }
            : undefined,
        releases:
          popularityScore >= 40
            ? [
                {
                  platform: Platform.PC,
                  store: Store.STEAM,
                  storeAppId: app.appid.toString(),
                  storeUrl: `https://store.steampowered.com/app/${app.appid}`,
                  releaseDateDate: releaseDate,
                  releaseDateRaw,
                  releaseStatus,
                  comingSoon: steamDetails.coming_soon,
                  currentPriceCents: steamDetails.price_overview?.initial,
                  isFree: Boolean(steamDetails.is_free),
                  followers,
                  reviewsTotal: totalReviews || undefined,
                  reviewScoreDesc: reviewScoreDesc || undefined,
                  dataSource: 'steam',
                },
              ]
            : [],
      };
      return processedGame;
    } catch (error: any) {
      if (error instanceof RateLimitExceededError) {
        throw error;
      }
      this.logger.error(
        `❌ ${prefix}게임 데이터 빌드 실패 - ${app.name}: ${error?.message ?? error}`,
      );
      return null;
    }
  }
  public async collectOneBySteamId(
    steamId: number,
    opts?: { mode?: 'bootstrap' | 'operational'; fallbackName?: string },
  ): Promise<ProcessedGameData | null> {
    // 이름 확보 (로그/슬러그 가독성용) — build 내부에서 AppDetails.name을 다시 우선 사용하므로 안전
    const cachedName = await this.lookupAppNameFromCache(steamId);
    const app: SteamApp = {
      appid: steamId,
      name: cachedName ?? opts?.fallbackName ?? `app-${steamId}`,
    };

    // 동일 파이프라인 실행 (followers/reviews/YouTube/인기도/DLC 규칙 그대로)
    return this.buildProcessedGameDataFromApp(app, { index: 0, total: 1 });
  }

  /** AppList 캐시에서 특정 appid의 이름을 찾아준다. (없으면 undefined) */
  private async lookupAppNameFromCache(
    steamId: number,
  ): Promise<string | undefined> {
    const apps = await this.getOrCacheAppList();
    // 선형 탐색 (한 번만 수행, 비용 미미)
    for (let i = 0; i < apps.length; i++) {
      if (apps[i].appid === steamId) return apps[i].name;
    }
    return undefined;
  }

  /**
   * AppList 체크섬 계산 (변경 감지용)
   * Phase 3 선행 구현
   */
  private computeChecksum(apps: SteamApp[]): string {
    if (!apps.length) return '0:0:0';
    const sorted = [...apps].sort((a, b) => a.appid - b.appid);
    return `${apps.length}:${sorted[0].appid}:${sorted[sorted.length - 1].appid}`;
  }

  /**
   * AppList 캐싱 (24h TTL + checksum 비교)
   * Phase 3 선행 구현 (원래 Phase 6)
   * TECHNICAL-DESIGN.md Section 3 구현
   */
  private async getOrCacheAppList(): Promise<SteamApp[]> {
    const TTL_MS = 24 * 60 * 60 * 1000; // 24시간
    const now = Date.now();

    // 캐시 유효하면 반환
    if (this.appListCache && now - this.appListCache.fetchedAt < TTL_MS) {
      const ageSeconds = Math.round((now - this.appListCache.fetchedAt) / 1000);
      this.logger.debug(`[AppListCache] 캐시 히트 (경과: ${ageSeconds}초)`);
      return this.appListCache.apps;
    }

    // API 호출
    const apps = await this.steamAppListService.fetchFullAppList();
    const checksum = this.computeChecksum(apps);

    // 체크섬 동일하면 타임스탬프만 갱신
    if (this.appListCache && this.appListCache.checksum === checksum) {
      this.logger.debug('[AppListCache] 체크섬 동일 → 타임스탬프만 갱신');
      this.appListCache.fetchedAt = now;
      return this.appListCache.apps;
    }

    // 캐시 갱신
    this.appListCache = { fetchedAt: now, checksum, apps };
    this.logger.log(`[AppListCache] 갱신 완료: ${apps.length}개 게임`);
    return apps;
  }

  /**
   * Steam 데이터 수집 및 가공 (Phase 3 재구현)
   * Pipeline Controller에서 호출
   *
   * @param options 수집 옵션 (mode, limit, strategy)
   * @returns 가공된 게임 데이터 배열
   */
  async collectProcessedData(
    options: SteamCollectOptions,
  ): Promise<ProcessedGameData[]> {
    this.logger.log(
      `🚀 [Steam Pipeline] 데이터 수집 시작 - mode: ${options.mode}, limit: ${options.limit}, strategy: ${options.strategy || 'latest'}`,
    );
    try {
      // ① AppList 캐싱 사용 (Phase 3 선행 구현)
      const allApps = await this.getOrCacheAppList();
      this.logger.log(`📥 [Steam Pipeline] AppList 조회: ${allApps.length}개`);

      const appIndex = new Map<number, SteamApp>();
      allApps.forEach((app) => appIndex.set(app.appid, app));

      // ② 전략별 후보군 선정 (리뷰 반영 개선)
      let selectedApps: SteamApp[] = [];
      let existingGames: ExistingGamesMap | undefined;

      if (options.mode === 'operational' && options.strategy === 'priority') {
        // priority 전략 (DB 조회 필요)
        this.logger.log('[Steam Pipeline] 전략: priority (복합 우선순위)');
        const bucketSizes = this.computePriorityBucketSizes(options.limit);
        existingGames = await this.loadExistingGamesMap(bucketSizes, appIndex);
        this.logger.log(
          `📊 [Steam Pipeline] 기존 게임 정보 로드: ${existingGames.size}개`,
        );
        selectedApps = this.selectPriorityApps(allApps, {
          limit: options.limit,
          mode: options.mode,
          existingGames,
        });
      } else {
        // latest (기본) 또는 bootstrap 모드
        this.logger.log(
          `[Steam Pipeline] 전략: ${options.strategy || 'latest'} (최신순)`,
        );
        selectedApps = this.selectPriorityApps(allApps, {
          limit: options.limit,
          mode: options.mode,
          existingGames: undefined,
        });
      }

      this.logger.log(
        `🎯 [Steam Pipeline] 후보 게임 선별: ${selectedApps.length}개`,
      );

      this.logger.log(
        `⚙️ [Steam Pipeline] 처리 동시성: ${this.processingConcurrency}개 워커`,
      );

      if (selectedApps.length === 0) {
        this.logger.warn('⚠️ [Steam Pipeline] 처리할 후보가 없습니다.');
        return [];
      }

      // ③ 각 게임의 상세정보 + 팔로워 + 인기도 계산
      this.logger.log(
        `🔄 [Steam Pipeline] 게임 데이터 가공 시작 (총 ${selectedApps.length}개)`,
      );
      const total = selectedApps.length;
      const results = await runWithConcurrency(
        selectedApps,
        this.processingConcurrency,
        async (app, index) => {
          const prefix = `[${index + 1}/${total}]`;
          const start = Date.now();

          try {
            this.logger.debug(
              `${prefix} 처리 시작: ${app.name} (AppID: ${app.appid})`,
            );
            const gameData = await this.buildProcessedGameDataFromApp(app, {
              index,
              total,
            });
            const durationMs = Date.now() - start;

            if (gameData) {
              this.logger.debug(
                `${prefix} 완료: ${app.name} (${durationMs}ms)`,
              );
              return gameData;
            }

            this.logger.warn(`${prefix} 스킵: ${app.name} (${durationMs}ms)`);
            return null;
          } catch (error) {
            const durationMs = Date.now() - start;
            this.logger.error(
              `${prefix} 실패: ${app.name} (${durationMs}ms) - ${error.message}`,
            );
            return null;
          }
        },
      );

      const processedData = results.filter(
        (result): result is ProcessedGameData => result !== null,
      );

      this.logger.log(
        `✨ [Steam Pipeline] 데이터 가공 완료: ${processedData.length}/${selectedApps.length}개`,
      );
      return processedData;
    } catch (error) {
      this.logger.error(
        `❌ [Steam Pipeline] 데이터 수집 실패: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * 우선순위 선별 (메모리 내 처리)
   * TECHNICAL-DESIGN.md Section 5 구현
   *
   * @param steamApps 전체 Steam 앱 목록
   * @param options 선별 옵션
   * @returns 우선순위 게임 목록
   */
  private selectPriorityApps(
    steamApps: SteamApp[],
    options: PrioritySelectionOptions,
  ): SteamApp[] {
    const EXCLUDE_KEYWORDS = ['soundtrack', 'demo', 'trailer', 'dlc', 'tool'];

    // 제외 키워드 필터링
    const filtered = steamApps.filter((app) => {
      const nameLower = app.name.toLowerCase();
      return !EXCLUDE_KEYWORDS.some((kw) => nameLower.includes(kw));
    });

    // Bootstrap 모드: 최신순만 (DB 정보 사용 금지)
    if (options.mode === 'bootstrap' || !options.existingGames) {
      return filtered.sort((a, b) => b.appid - a.appid).slice(0, options.limit);
    }

    // Operational 모드: 복합 우선순위 (40% 최신 / 20% 출시 임박 / 40% 인기)
    const {
      latest: nLatest,
      soon: nSoon,
      popular: nPop,
    } = this.computePriorityBucketSizes(options.limit);

    // 40% 최신 (AppID 내림차순)
    const latestApps = filtered
      .sort((a, b) => b.appid - a.appid)
      .slice(0, nLatest);

    // 20% 출시임박 (coming_soon=true, release_date 가까운 순)
    const comingSoonApps = filtered
      .filter(
        (app) => options.existingGames!.get(app.appid)?.coming_soon === true,
      )
      .sort((a, b) => {
        const releaseA =
          options.existingGames!.get(a.appid)?.release_date_date ?? null;
        const releaseB =
          options.existingGames!.get(b.appid)?.release_date_date ?? null;

        const parsedA =
          releaseA instanceof Date
            ? releaseA.getTime()
            : releaseA
            ? new Date(releaseA as any).getTime()
            : NaN;
        const parsedB =
          releaseB instanceof Date
            ? releaseB.getTime()
            : releaseB
            ? new Date(releaseB as any).getTime()
            : NaN;

        const dateA = Number.isFinite(parsedA) ? parsedA : Infinity;
        const dateB = Number.isFinite(parsedB) ? parsedB : Infinity;

        return dateA - dateB;
      })
      .slice(0, nSoon);

    // 40% 인기 (followers_cache > 1000, 높은 순)
    const popularApps = filtered
      .filter(
        (app) =>
          (options.existingGames!.get(app.appid)?.followers_cache ?? 0) > 1000,
      )
      .sort((a, b) => {
        const followersA =
          options.existingGames!.get(a.appid)?.followers_cache ?? 0;
        const followersB =
          options.existingGames!.get(b.appid)?.followers_cache ?? 0;
        return followersB - followersA;
      })
      .slice(0, nPop);

    // 중복 제거 + 부족분 최신순 보충
    const merged = new Map<number, SteamApp>();
    [...latestApps, ...comingSoonApps, ...popularApps].forEach((app) =>
      merged.set(app.appid, app),
    );

    if (merged.size < options.limit) {
      const remaining = filtered
        .filter((app) => !merged.has(app.appid))
        .sort((a, b) => b.appid - a.appid)
        .slice(0, options.limit - merged.size);
      remaining.forEach((app) => merged.set(app.appid, app));
    }

    return Array.from(merged.values()).slice(0, options.limit);
  }

  private computePriorityBucketSizes(limit: number): {
    latest: number;
    soon: number;
    popular: number;
  } {
    const safeLimit = Math.max(1, limit);
    const latest = Math.floor(safeLimit * 0.4);
    const soon = Math.floor(safeLimit * 0.2);
    const popular = Math.floor(safeLimit * 0.4);
    const remainder = safeLimit - (latest + soon + popular);
    return {
      latest: latest + remainder,
      soon,
      popular,
    };
  }

  /**
   * 기존 게임 정보 로드 (Operational 모드 전용)
   * TECHNICAL-DESIGN.md Section 5.1 구현
   *
   * @param appIds Steam AppID 목록
   * @returns 기존 게임 정보 맵
   */
  private async loadExistingGamesMap(
    bucketSizes: { latest: number; soon: number; popular: number },
    appIndex: Map<number, SteamApp>,
  ): Promise<ExistingGamesMap> {
    const snapshot =
      await this.existingGamesSnapshotService.loadPriorityBuckets(bucketSizes);
    if (appIndex.size === 0) {
      return snapshot;
    }

    const filtered: ExistingGamesMap = new Map();
    snapshot.forEach((value, steamId) => {
      if (appIndex.has(steamId)) {
        filtered.set(steamId, value);
      }
    });
    return filtered;
  }
  async listAllSteamAppIdsV2(): Promise<number[]> {
    // 이미 갖고 있는 AppList v2 fetcher를 thin wrapper로 노출
    const list = await this.steamAppListService.fetchFullAppList(); // [{ appid, name }, ...]
    return list
      .map((x) => Number(x.appid))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  async collectManyBySteamIds(
    ids: number[],
    opts: { mode: 'bootstrap' | 'operational' } = { mode: 'operational' },
  ): Promise<ProcessedGameData[]> {
    // 내부에서 기존 collectOneBySteamId를 재사용 — 동시성 제한은 서비스/컨트롤러 레벨에서
    const results: ProcessedGameData[] = [];
    for (const id of ids) {
      const one = await this.collectOneBySteamId(id, opts);
      if (one) results.push(one);
    }
    return results;
  }
  /**
   * SteamApp을 ProcessedGameData로 가공
   * (기존 buildProcessedGameData를 대체)
   *
   * @param app Steam 앱 정보
   * @returns 가공된 게임 데이터
   */

  /**
   * 증분 업데이트용 동기화 상태 조회
   * Phase 3 인터페이스 준비 (실제 구현은 Phase 8)
   * TECHNICAL-DESIGN.md Section 7 구현
   */
  private async getSyncStatus(syncName: string): Promise<{
    lastProcessedAppId: number;
    lastSyncedAt: string;
    newGamesCount: number;
    totalProcessed: number;
    syncVersion: number;
  } | null> {
    const row = await this.dataSyncStatusRepository.findOne({
      where: { sync_name: syncName },
    });

    if (!row || !row.sync_data) return null;

    const data = row.sync_data;
    return {
      lastProcessedAppId: data.lastProcessedAppId ?? 0,
      lastSyncedAt: data.lastSyncedAt ?? new Date(0).toISOString(),
      newGamesCount: data.newGamesCount ?? 0,
      totalProcessed: data.totalProcessed ?? 0,
      syncVersion: data.syncVersion ?? 1,
    };
  }

  /**
   * 증분 업데이트 - 신규 게임 조회
   * Phase 3 인터페이스 준비 (실제 구현은 Phase 8)
   * TECHNICAL-DESIGN.md Section 7 구현
   *
   * @param options limit, existingRecentAppIds (선택적 보강)
   * @returns 신규 게임 목록
   */
  async getIncrementalUpdates(options: {
    limit: number;
    existingRecentAppIds?: Set<number>;
  }): Promise<SteamApp[]> {
    // ① 전체 AppList 조회 (캐시 사용)
    const allApps = await this.getOrCacheAppList();

    // ② 마지막 동기화 상태
    const syncStatus = await this.getSyncStatus('steam_incremental_update');
    const lastAppId = syncStatus?.lastProcessedAppId ?? 0;

    // ③ 신규 게임 필터링
    const newApps = allApps.filter((app) => app.appid > lastAppId);

    // ④ 신규 게임이 충분하면 반환
    if (newApps.length >= options.limit) {
      return newApps.sort((a, b) => b.appid - a.appid).slice(0, options.limit);
    }

    // ⑤ 부족분 보강 (최근 게임 제외)
    const exclude = options.existingRecentAppIds ?? new Set<number>();
    const fillApps = allApps
      .filter(
        (app) =>
          app.appid <= lastAppId &&
          !exclude.has(app.appid) &&
          !newApps.find((n) => n.appid === app.appid),
      )
      .sort((a, b) => b.appid - a.appid)
      .slice(0, options.limit - newApps.length);

    return [...newApps, ...fillApps];
  }

  /**
   * 증분 업데이트 동기화 상태 갱신
   * Phase 3 인터페이스 준비 (실제 구현은 Phase 8)
   * TECHNICAL-DESIGN.md Section 7 구현
   *
   * @param lastAppId 마지막 처리된 AppID
   * @param processedCount 처리된 게임 수
   */
  async updateSyncStatus(
    lastAppId: number,
    processedCount: number,
  ): Promise<void> {
    const syncData = {
      lastProcessedAppId: lastAppId,
      lastSyncedAt: new Date().toISOString(),
      newGamesCount: processedCount,
      totalProcessed: 0, // Phase 8에서 누적 계산
      syncVersion: 1,
    };

    await this.dataSyncStatusRepository.upsert(
      {
        sync_name: 'steam_incremental_update',
        sync_data: syncData as any, // JSONB 타입
      },
      ['sync_name'],
    );

    this.logger.log(
      `[SyncStatus] 갱신 완료: lastAppId=${lastAppId}, count=${processedCount}`,
    );
  }

  /**
   * 출시 윈도우(S 티어) 갱신 대상 수집 및 가공
   */
  async collectReleaseWindowRefreshData(limit: number): Promise<{
    candidates: SteamRefreshCandidate[];
    processed: ProcessedGameData[];
  }> {
    this.logger.log(
      `🚀 [Steam Refresh] 출시 윈도우 갱신 시작 (limit: ${limit})`,
    );

    const games = await this.findReleaseWindowCandidates(limit);
    if (games.length === 0) {
      this.logger.warn('⚠️ [Steam Refresh] 조건을 만족하는 후보가 없습니다.');
      return { candidates: [], processed: [] };
    }

    const candidates: SteamRefreshCandidate[] = games.map((game) => ({
      gameId: Number(game.id),
      steamId: Number(game.steam_id),
      name: game.name,
      slug: game.slug,
    }));

    this.logger.log(
      `🎯 [Steam Refresh] 후보 선정 완료: ${candidates.length}개`,
    );

    const apps = candidates.map((candidate) => ({
      appid: candidate.steamId,
      name: candidate.name,
    }));

    const total = apps.length;
    this.logger.log(
      `🔄 [Steam Refresh] 후보 가공 시작 (총 ${total}개, 동시성 ${this.processingConcurrency})`,
    );

    const results = await runWithConcurrency(
      apps,
      this.processingConcurrency,
      async (app, index) => {
        const prefix = `[Refresh ${index + 1}/${total}]`;
        const startedAt = Date.now();
        try {
          const processed = await this.buildProcessedGameDataFromApp(app, {
            index,
            total,
          });
          const durationMs = Date.now() - startedAt;
          if (processed) {
            this.logger.debug(`${prefix} 완료: ${app.name} (${durationMs}ms)`);
            return processed;
          }
          this.logger.warn(`${prefix} 스킵: ${app.name} (${durationMs}ms)`);
          return null;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          this.logger.error(
            `${prefix} 실패: ${app.name} (${durationMs}ms) - ${
              (error as Error).message
            }`,
          );
          return null;
        }
      },
    );

    const processed = results.filter(
      (item): item is ProcessedGameData => item !== null,
    );

    this.logger.log(
      `✨ [Steam Refresh] 가공 완료: ${processed.length}/${total}개`,
    );

    return { candidates, processed };
  }

  private async findReleaseWindowCandidates(limit: number): Promise<Game[]> {
    const now = new Date();
    const startDate = this.formatDateString(this.addDays(now, -30));
    const endDate = this.formatDateString(this.addDays(now, 60));
    const refreshThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    return this.gameRepository
      .createQueryBuilder('game')
      .where('game.steam_id IS NOT NULL')
      .andWhere("game.game_type <> 'dlc'")
      .andWhere(
        new Brackets((qb) => {
          qb.where('game.popularity_score >= :popularity', {
            popularity: 40,
          }).orWhere('game.followers_cache >= :followers', { followers: 5000 });
        }),
      )
      .andWhere(
        new Brackets((qb) => {
          qb.where('game.coming_soon = true')
            .orWhere('game.release_status IN (:...statuses)', {
              statuses: [ReleaseStatus.COMING_SOON, ReleaseStatus.EARLY_ACCESS],
            })
            .orWhere('game.release_date_date BETWEEN :startDate AND :endDate', {
              startDate,
              endDate,
            });
        }),
      )
      .andWhere(
        new Brackets((qb) => {
          qb.where('game.steam_last_refresh_at IS NULL').orWhere(
            'game.steam_last_refresh_at <= :threshold',
            { threshold: refreshThreshold },
          );
        }),
      )
      .orderBy('game.steam_last_refresh_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('game.release_date_date', 'ASC')
      .addOrderBy('game.popularity_score', 'DESC')
      .limit(limit)
      .getMany();
  }

  private addDays(base: Date, days: number): Date {
    const copy = new Date(base.getTime());
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }

  private formatDateString(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  /**
   * 슬러그 생성 (URL 친화적, 다국어 지원)
   *
   * ⚠️ DEPRECATED: 이 메서드는 normalizeGameName()으로 대체되었습니다.
   * - 그리스 문자, 로마 숫자, 특수 기호 정규화 미지원
   * - 플랫폼 간 이름 표기 차이로 인한 중복 게임 문제 발생
   *
   * @deprecated src/common/utils/game-name-normalizer.util.ts의 normalizeGameName() 사용
   */
  private generateSlug(name: string, fallbackId?: number): string {
    // ⚠️ 하위 호환성을 위해 유지하지만, normalizeGameName()을 사용하도록 변경됨
    const {
      normalizeGameName,
    } = require('../../common/utils/game-name-normalizer.util');
    return normalizeGameName(name, fallbackId);
  }
}

// ✅ 지원 포맷
// - "19 Aug, 2024", "Aug 19, 2024", "19 Aug 2024"
// - "2013년 7월 9일"
// - "2024-08-19", "2024/08/19", "2024.08.19"
// - "Oct 2025" / "October 2025"  (월/년)
// - "Q3 2025"                    (분기/년)
// - "2026"                       (연도)

// 필요 타입 가정
// type SteamReleaseDateRaw = { coming_soon?: boolean; date?: string | null };
// enum ReleaseStatus { RELEASED='released', COMING_SOON='coming_soon', TBA='tba', EARLY_ACCESS='early_access', CANCELLED='cancelled' }

const M: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const makeUTC = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m, d));
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0));
const quarterEnd = (y: number, q: number) => monthEnd(y, [2, 5, 8, 11][q - 1]);
const statusBy = (d: Date) =>
  d.getTime() <= Date.now()
    ? ReleaseStatus.RELEASED
    : ReleaseStatus.COMING_SOON;

// 여러 일자 포맷을 한 번에 처리
function parseExactDay(s: string): Date | null {
  const text = s.trim();

  // 1) D Mon(,)? YYYY  e.g. "19 Aug, 2024" / "19 Aug 2024"
  let m = text.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (m) {
    const mon = M[m[2].toLowerCase()];
    if (mon != null) return makeUTC(+m[3], mon, +m[1]);
  }

  // 2) Mon D(,)? YYYY  e.g. "Aug 19, 2024" / "August 19 2024"
  m = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mon = M[m[1].toLowerCase()];
    if (mon != null) return makeUTC(+m[3], mon, +m[2]);
  }

  // 3) ISO 유사: YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
  m = text.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (m) return makeUTC(+m[1], +m[2] - 1, +m[3]);

  // 4) 한국어: YYYY년 M월 D일
  m = text.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일$/);
  if (m) return makeUTC(+m[1], +m[2] - 1, +m[3]);

  // 5) D Month YYYY (콤마 없는 변형) e.g. "9 July 2013"
  m = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mon = M[m[2].toLowerCase()];
    if (mon != null) return makeUTC(+m[3], mon, +m[1]);
  }

  return null;
}

const qRe = /^q\s*([1-4])\s*(\d{4})$/i;
const myRe = /^([A-Za-z]+)\s+(\d{4})$/i;
const yRe = /^(\d{4})$/;

export function parseSteamRelease(
  steam: SteamReleaseDateRaw | null | undefined,
): {
  releaseDate: Date | null; // “일” 단위일 때만 Date, 아니면 null
  releaseDateRaw: string; // 원문 보존
  releaseStatus: ReleaseStatus;
} {
  const base = steam?.coming_soon
    ? ReleaseStatus.COMING_SOON
    : ReleaseStatus.RELEASED;
  const raw = (steam?.date ?? '').trim();
  if (!raw)
    return { releaseDate: null, releaseDateRaw: '', releaseStatus: base };

  // 접두어 제거 (예: "Planned Release Date: Q4 2025")
  const text = (
    raw.includes(':') ? raw.split(':').slice(1).join(':') : raw
  ).trim();
  const low = text.toLowerCase();

  // 명시 키워드
  if (low === 'tba' || low === 'to be announced')
    return {
      releaseDate: null,
      releaseDateRaw: raw,
      releaseStatus: ReleaseStatus.TBA,
    };

  if (low === 'coming soon')
    return {
      releaseDate: null,
      releaseDateRaw: raw,
      releaseStatus: ReleaseStatus.COMING_SOON,
    };

  if (low.includes('early access')) {
    const d = parseExactDay(text); // 날짜가 같이 써있는 경우만 Date 보존
    return {
      releaseDate: d,
      releaseDateRaw: raw,
      releaseStatus: ReleaseStatus.EARLY_ACCESS,
    };
  }

  if (low.includes('cancelled') || low.includes('canceled'))
    return {
      releaseDate: null,
      releaseDateRaw: raw,
      releaseStatus: ReleaseStatus.CANCELLED,
    };

  if (low.includes('available now'))
    return {
      releaseDate: null,
      releaseDateRaw: raw,
      releaseStatus: ReleaseStatus.RELEASED,
    };

  // 1) 정확한 일자
  const d = parseExactDay(text);
  if (d)
    return { releaseDate: d, releaseDateRaw: raw, releaseStatus: statusBy(d) };

  // 2) 분기 (Q1~Q4 YYYY)
  const q = text.match(qRe);
  if (q) {
    const b = quarterEnd(+q[2], +q[1]);
    return {
      releaseDate: null,
      releaseDateRaw: raw,
      releaseStatus: statusBy(b),
    };
  }

  // 3) 월/년 (Oct 2025 / October 2025)
  const my = text.match(myRe);
  if (my) {
    const mon = M[my[1].toLowerCase()];
    if (mon != null) {
      const b = monthEnd(+my[2], mon);
      return {
        releaseDate: null,
        releaseDateRaw: raw,
        releaseStatus: statusBy(b),
      };
    }
  }

  // 4) 연도만 (2026)
  const y = text.match(yRe);
  if (y) {
    const b = makeUTC(+y[1], 11, 31);
    return {
      releaseDate: null,
      releaseDateRaw: raw,
      releaseStatus: statusBy(b),
    };
  }

  // 5) 그 외 → coming_soon 플래그만 사용, 원문 보존
  return { releaseDate: null, releaseDateRaw: raw, releaseStatus: base };
}
