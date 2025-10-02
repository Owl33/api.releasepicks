import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

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
} from '../../pipeline/types/pipeline.types';
import { SteamApp } from './steam-applist.service';

// 유틸
import { PopularityCalculator } from '../../common/utils/popularity-calculator.util';

// YouTube 서비스 추가 (Phase 4)
import { YouTubeService } from '../../youtube/youtube.service';

// Batch Strategy 서비스 추가 (Phase 5 성능 최적화)
import { SteamBatchStrategyService } from './steam-batch-strategy.service';

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
    private readonly batchStrategyService: SteamBatchStrategyService, // Phase 5: Batch Strategy
  ) {}

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

    const processedData: ProcessedGameData[] = [];

    try {
      // ① AppList 캐싱 사용 (Phase 3 선행 구현)
      const allApps = await this.getOrCacheAppList();
      this.logger.log(`📥 [Steam Pipeline] AppList 조회: ${allApps.length}개`);

      // ② 전략별 후보군 선정 (리뷰 반영 개선)
      let selectedApps: SteamApp[] = [];

      if (options.mode === 'operational' && options.strategy === 'priority') {
        // priority 전략 (DB 조회 필요)
        this.logger.log('[Steam Pipeline] 전략: priority (복합 우선순위)');
        const appIds = allApps.map((app) => app.appid);
        const existingGames = await this.loadExistingGamesMap(appIds);
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

      // ③ 각 게임의 상세정보 + 팔로워 + 인기도 계산
      this.logger.log(
        `🔄 [Steam Pipeline] 게임 데이터 가공 시작 (총 ${selectedApps.length}개)`,
      );

      for (let i = 0; i < selectedApps.length; i++) {
        const app = selectedApps[i];
        const startTime = Date.now();

        try {
          this.logger.log(
            `[${i + 1}/${selectedApps.length}] 처리 중: ${app.name} (AppID: ${app.appid})`,
          );

          const gameData = await this.buildProcessedGameDataFromApp(app);

          const duration = Date.now() - startTime;
          const durationSeconds = (duration / 1000).toFixed(2);

          if (gameData) {
            processedData.push(gameData);
            this.logger.log(
              `✅ [${i + 1}/${selectedApps.length}] 완료: ${app.name} (${durationSeconds}초)`,
            );
          } else {
            this.logger.warn(
              `⚠️ [${i + 1}/${selectedApps.length}] 스킵: ${app.name} (${durationSeconds}초)`,
            );
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          const durationSeconds = (duration / 1000).toFixed(2);
          this.logger.error(
            `❌ [${i + 1}/${selectedApps.length}] 실패: ${app.name} (${durationSeconds}초) - ${error.message}`,
          );
        }
      }

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
    const nLatest = Math.floor(options.limit * 0.4);
    const nSoon = Math.floor(options.limit * 0.2);
    const nPop = Math.floor(options.limit * 0.4);

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
        const dateA =
          options.existingGames!.get(a.appid)?.release_date_date?.getTime() ??
          Infinity;
        const dateB =
          options.existingGames!.get(b.appid)?.release_date_date?.getTime() ??
          Infinity;
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

  /**
   * 기존 게임 정보 로드 (Operational 모드 전용)
   * TECHNICAL-DESIGN.md Section 5.1 구현
   *
   * @param appIds Steam AppID 목록
   * @returns 기존 게임 정보 맵
   */
  private async loadExistingGamesMap(
    appIds: number[],
  ): Promise<ExistingGamesMap> {
    const games = await this.gameRepository
      .createQueryBuilder('g')
      .select([
        'g.steam_id',
        'g.coming_soon',
        'g.release_date_date',
        'g.followers_cache',
        'g.popularity_score',
      ])
      .where('g.steam_id IN (:...appIds)', { appIds })
      .getMany();

    const map = new Map();
    games.forEach((game) => {
      if (game.steam_id) {
        map.set(game.steam_id, {
          steam_id: game.steam_id,
          coming_soon: game.coming_soon,
          release_date_date: game.release_date_date,
          followers_cache: Math.round(Number(game.followers_cache)),
          popularity_score: game.popularity_score,
        });
      }
    });

    return map;
  }

  /**
   * SteamApp을 ProcessedGameData로 가공
   * (기존 buildProcessedGameData를 대체)
   *
   * @param app Steam 앱 정보
   * @returns 가공된 게임 데이터
   */
  private async buildProcessedGameDataFromApp(
    app: SteamApp,
  ): Promise<ProcessedGameData | null> {
    try {
      const timers: { [key: string]: number } = {};

      // Steam AppDetails 호출
      timers.appDetailsStart = Date.now();
      const steamDetails = await this.steamAppDetailsService.fetchAppDetails(
        app.appid,
      );
      timers.appDetailsDuration = Date.now() - timers.appDetailsStart;
      this.logger.debug(
        `  ⏱️  AppDetails: ${(timers.appDetailsDuration / 1000).toFixed(2)}초`,
      );

      if (!steamDetails) {
        this.logger.debug(`  ⚠️  Steam AppDetails 없음: ${app.name}`);
        return null;
      }
      // 슬러그 생성
      const slug = this.generateSlug(app.name);
      // 팔로워 정보 수집 (스크레이핑)

      // 인기도 점수 계산 (PopularityCalculator 사용)

      timers.followersStart = Date.now();
      const followers = await this.steamCommunityService.scrapeFollowers(
        app.appid,
        app.name,
      );
      timers.followersDuration = Date.now() - timers.followersStart;
      this.logger.debug(
        `  ⏱️  Followers 스크레이핑: ${(timers.followersDuration / 1000).toFixed(2)}초 (${followers || 0}명)`,
      );

      let totalReviews: number = 0;
      let reviewScoreDesc: string = '';
      let youtubeVideoUrl: string | undefined;
      let popularityScore = PopularityCalculator.calculateSteamPopularity(
        followers || 0,
      );

      const hasKorean =
        Array.isArray(steamDetails.supported_languages) &&
        steamDetails.supported_languages.includes('한국어');

      // if (hasKorean || popularityScore >= 80) {
      //   if (hasKorean) {
      //   } else {
      //     this.logger.debug('  ✅ 한국어 없음 — 인기도 예외 적용(>=80)');
      //   }
      this.logger.debug(`  📊 인기도 점수: ${popularityScore}점`);

      if (popularityScore >= 40) {
        try {
          const result = await this.steamReviewService.fetchAppReview(
            app.appid,
          );

          totalReviews = result?.total_reviews || 0;
          reviewScoreDesc = result?.review_score_desc || '';
        } catch (error) {
          this.logger.warn(`  ⚠️  review 실패 ( ${error.message}`);
        }
      }

      // YouTube 트레일러 조회 (Phase 4: 인기도 40점 이상만)
      if (popularityScore >= 40) {
        timers.youtubeStart = Date.now();
        try {
          const trailerResult = await this.youtubeService.findOfficialTrailer(
            app.name,
          );
          const picked = trailerResult?.picked;

          if (picked?.url) {
            youtubeVideoUrl = picked.url; // 이미 완성 URL 있음
            timers.youtubeDuration = Date.now() - timers.youtubeStart;
            this.logger.debug(
              `  ⏱️  YouTube 트레일러: ${(app.name, (timers.youtubeDuration / 1000).toFixed(2))}초 - ${youtubeVideoUrl}`,
            );
          }
        } catch (error) {
          timers.youtubeDuration = Date.now() - timers.youtubeStart;
          this.logger.warn(
            `  ⚠️  YouTube 조회 실패 (${(timers.youtubeDuration / 1000).toFixed(2)}초): ${error.message}`,
          );
        }
      } else {
        this.logger.debug(
          `  ⏭️  YouTube 스킵 (인기도 ${popularityScore}점 < 40점)`,
        );
      }
      // } else {
      //   // ⭐ 스킵 시에도 return/continue 없이 로그만
      //   this.logger.debug(
      //     `  ⏭️ 한국어 미지원 → 스킵 (인기도 ${popularityScore}점  80점 이하)`,
      //   );
      // }
      // ===== Phase 5.5: DLC 감지 및 부모 정보 추출 =====
      const isDlcType = steamDetails.type?.toLowerCase() === 'dlc';

      // ⚠️ fullgame.appid는 문자열로 올 수 있음 (예: "4013450") → 숫자로 변환 필요
      let parentSteamId: number | undefined;
      if (steamDetails.fullgame.appid) {
        const appidRaw = steamDetails.fullgame.appid;
        const appidNum =
          typeof appidRaw === 'string' ? Number(appidRaw) : appidRaw;
        parentSteamId = !isNaN(appidNum) ? appidNum : undefined;
      }

      // DLC인데 부모 정보가 없으면 제약 조건 위반 방지 (본편으로 저장)
      const isDlc = isDlcType && !!parentSteamId;
      const gameType = isDlc ? GameType.DLC : GameType.GAME;
      if (isDlcType && !parentSteamId) {
        this.logger.warn(
          `  ⚠️ [DLC 부모 없음] ${app.name} - 본편으로 저장 (fullgame.appid 파싱 실패 또는 없음)`,
        );
      }

      // 본편일 경우 DLC 리스트 추출 (백필용)
      const childDlcSteamIds = !isDlc
        ? ((steamDetails as any).dlc as number[]) || undefined
        : undefined;

      if (isDlc) {
        this.logger.debug(
          `  🎯 [DLC 감지] ${app.name} → 부모 Steam ID: ${parentSteamId}`,
        );
      } else if (childDlcSteamIds && childDlcSteamIds.length > 0) {
        this.logger.debug(
          `  📦 [본편] ${app.name} → DLC ${childDlcSteamIds.length}개 발견`,
        );
      }

      const parsed = parseSteamRelease(steamDetails?.release_date);

      const releaseDate = parsed.releaseDate; // Date | null (정확 “일”만)
      const releaseDateRaw = parsed.releaseDateRaw; // string | null (원문)
      const releaseStatus = parsed.releaseStatus as ReleaseStatus;

      // ProcessedGameData 구조로 변환
      const processedGame: ProcessedGameData = {
        name: app.name,
        slug: slug,
        steamId: app.appid,
        rawgId: undefined,
        gameType: gameType,
        parentSteamId: parentSteamId,
        parentRawgId: undefined,
        parentReferenceType: undefined,

        // ===== Phase 5.5: DLC 메타데이터 =====
        isDlc: isDlc,
        platformType: 'pc',
        childDlcSteamIds: childDlcSteamIds,

        releaseDate: releaseDate,
        releaseDateRaw: releaseDateRaw,
        releaseStatus: releaseStatus,
        comingSoon: steamDetails.coming_soon,
        popularityScore: popularityScore,
        followersCache: followers ?? undefined,
        platformsSummary: ['pc'],

        // 회사 정보 (개발사/퍼블리셔)
        // ✅ Steam: ['ubisoft'] 문자열 배열
        // ✅ RAWG: [{ id: 123, name: "ubisoft", slug: "..." }] 객체 배열
        // 두 형식 모두 지원
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

        // 상세 정보 (인기도 40점 이상, B등급부터)
        details:
          popularityScore >= 40
            ? {
                screenshots:
                  (steamDetails.screenshots as any[])?.slice(0, 5) || [],
                videoUrl:
                  youtubeVideoUrl ||
                  (steamDetails.movies as any[])?.[0]?.mp4?.max, // Phase 4: YouTube 우선, fallback Steam
                description:
                  (steamDetails.detailed_description as string) || undefined,
                website: (steamDetails.website as string) || undefined,
                genres: (steamDetails.genres as any[]) || [],
                tags: steamDetails.categories || null, // Steam에서 태그 정보는 별도 API 필요
                supportLanguages: steamDetails.supported_languages || [],
                metacriticScore: steamDetails.metacritic || null,
                platformType: 'pc',
                totalReviews: totalReviews,
                reviewScoreDesc: reviewScoreDesc,
              }
            : undefined,

        // 릴리스 정보
        releases:
          popularityScore >= 40
            ? [
                {
                  platform: Platform.PC,
                  store: Store.STEAM,
                  storeAppId: app.appid.toString(),
                  storeUrl: `https://store.steampowered.com/app/${app.appid}`,
                  releaseDateDate: releaseDate,
                  releaseDateRaw: releaseDateRaw,
                  releaseStatus: releaseStatus,
                  comingSoon: steamDetails.coming_soon,
                  currentPriceCents: (steamDetails.price_overview as any)
                    ?.initial,
                  isFree: (steamDetails.is_free as boolean) || false,
                  followers: followers,
                  reviewsTotal: undefined,
                  reviewScoreDesc: undefined,
                  dataSource: 'steam',
                },
              ]
            : [],
      };
      return processedGame;
    } catch (error) {
      this.logger.error(
        `❌ [Steam Pipeline] 게임 데이터 빌드 실패 - ${app.name}: ${error.message}`,
      );
      return null;
    }
  }

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
   * 점진적 배치 수집 (Phase 5 성능 최적화)
   * 15만 개 게임을 안전하게 단계적으로 수집
   *
   * ⚠️ 주의: 배치 진행 상태 업데이트는 Controller에서 저장 성공 후 수행
   * @param limit - 사용자 지정 수집 개수 (옵셔널, 미지정 시 자동 배치 크기 사용)
   * @returns 이번 배치에서 수집된 게임 데이터
   */
  async collectBatchData(limit?: number): Promise<ProcessedGameData[]> {
    // 1. 다음 배치 정보 조회
    const batch = await this.batchStrategyService.getNextBatch();

    if (batch.isComplete) {
      this.logger.log('🎉 [Batch Strategy] 전체 수집 완료! (150,000개)');
      return [];
    }

    // ✅ 사용자 지정 limit이 있으면 배치 크기 오버라이드
    const actualBatchSize = limit ?? batch.batchSize;
    const actualEndIndex = batch.startIndex + actualBatchSize;

    this.logger.log(
      `🚀 [Batch Strategy] 배치 수집 시작: ${batch.startIndex}-${actualEndIndex} (${actualBatchSize}개)${limit ? ' [사용자 지정]' : ' [자동]'}`,
    );

    // 2. AppList 조회 및 슬라이싱
    const allApps = await this.getOrCacheAppList();
    const batchApps = allApps.slice(batch.startIndex, actualEndIndex);

    this.logger.log(
      `📥 [Batch Strategy] AppList 슬라이스: ${batchApps.length}개`,
    );

    // 3. 배치 데이터 수집
    const processedData: ProcessedGameData[] = [];

    for (let i = 0; i < batchApps.length; i++) {
      const app = batchApps[i];
      const globalIndex = batch.startIndex + i;
      const startTime = Date.now();

      try {
        this.logger.log(
          `[${globalIndex + 1}/150,000] 처리 중: ${app.name} (AppID: ${app.appid})`,
        );

        const gameData = await this.buildProcessedGameDataFromApp(app);

        const duration = Date.now() - startTime;
        const durationSeconds = (duration / 1000).toFixed(2);

        if (gameData) {
          processedData.push(gameData);
          this.logger.log(
            `✅ [${globalIndex + 1}/150,000] 완료: ${app.name} (${durationSeconds}초)`,
          );
        } else {
          this.logger.warn(
            `⚠️ [${globalIndex + 1}/150,000] 스킵: ${app.name} (${durationSeconds}초)`,
          );
        }
      } catch (error) {
        const duration = Date.now() - startTime;
        const durationSeconds = (duration / 1000).toFixed(2);
        this.logger.error(
          `❌ [${globalIndex + 1}/150,000] 실패: ${app.name} (${durationSeconds}초) - ${error.message}`,
        );
      }

      // 진행 상황 로그 (매 100개마다)
      if ((i + 1) % 100 === 0) {
        const progress = ((batch.startIndex + i + 1) / 150000) * 100;
        this.logger.log(
          `📊 [Batch Strategy] 전체 진행률: ${batch.startIndex + i + 1}/150,000 (${progress.toFixed(2)}%)`,
        );
      }
    }

    // ✅ 배치 진행 상태 업데이트는 Controller에서 저장 성공 후 수행 (저장 실패분 제외)
    this.logger.log(
      `✨ [Batch Strategy] 배치 수집 완료: ${processedData.length}/${batch.batchSize}개`,
    );

    return processedData;
  }

  /**
   * 배치 진행 상황 조회
   */
  async getBatchProgress(): Promise<{
    totalProcessed: number;
    totalTarget: number;
    percentage: number;
    estimatedRemaining: string;
    currentStage: string;
  }> {
    return this.batchStrategyService.getProgressStats();
  }

  /**
   * 배치 진행 상태 초기화 (재시작 시)
   */
  async resetBatchProgress(): Promise<void> {
    await this.batchStrategyService.resetProgress();
  }

  /**
   * 슬러그 생성 (URL 친화적, 다국어 지원)
   * - 영어, 숫자, 한글, 일본어(히라가나/가타카나/한자) 지원
   * - 특수문자 제거, 공백을 하이픈으로 변환
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9가-힣ぁ-んァ-ヶ一-龯\s-]/g, '') // 특수문자 제거 (영어/숫자/한글/일본어 허용)
      .replace(/\s+/g, '-') // 공백을 하이픈으로
      .replace(/-+/g, '-') // 연속 하이픈 제거
      .replace(/^-|-$/g, '') // 앞뒤 하이픈 제거
      .substring(0, 100); // 길이 제한
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
