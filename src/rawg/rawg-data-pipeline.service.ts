// src/services/rawg/rawg-data-pipeline.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RawgApiService } from './rawg-api.service';
import { RAWG_COLLECTION, RAWG_PLATFORM_IDS } from './config/rawg.config';
import {
  generateMonthRange,
  buildMonthlyParams,
} from './utils/rawg-query-builder.util';
import { extractPlatformFamilies } from './utils/platform-normalizer';
import { RawgGameSearchResult } from './rawg.types';
import { ProcessedGameData } from '../pipeline/types/pipeline.types';
import { GameType, ReleaseStatus, CompanyRole } from '../entities/enums';
import { PopularityCalculator } from '../common/utils/popularity-calculator.util';

// YouTube 서비스 추가 (Phase 4)
import { YouTubeService } from '../youtube/youtube.service';

export interface CollectProcessedDataOptions {
  // 기존 호출부를 존중: 필요한 옵션만 해석 (없으면 전역 기본값 사용)
  monthsBack?: number; // default 12
  monthsForward?: number; // default 6
  limitMonths?: number; // 테스트용: 앞에서 N개월만
  ordering?: '-released' | '-added';
  metacritic?: string; // 운영 옵션
}

@Injectable()
export class RawgDataPipelineService {
  private readonly logger = new Logger(RawgDataPipelineService.name);

  constructor(
    private readonly rawgApiService: RawgApiService,
    private readonly youtubeService: YouTubeService, // Phase 4: YouTube 서비스 주입
  ) {}

  /**
   * ✅ 공개 API 이름 유지: collectProcessedData()
   * 내부 로직은 "월 단위 통합 수집(PS+Xbox+Nintendo, 각 월 최대 50개)"으로 동작
   * @returns ProcessedGameData[] - 파이프라인 컨트롤러가 기대하는 표준 형식
   */
  async collectProcessedData(
    opts: CollectProcessedDataOptions = {},
  ): Promise<ProcessedGameData[]> {
    const pastMonths = opts.monthsBack ?? RAWG_COLLECTION.pastMonths;
    const futureMonths = opts.monthsForward ?? RAWG_COLLECTION.futureMonths;
    const limitMonths = opts.limitMonths;
    const ordering = opts.ordering ?? RAWG_COLLECTION.ordering;
    const metacritic = opts.metacritic; // 기본 OFF

    const months = generateMonthRange(pastMonths, futureMonths);
    const rawResults: Array<{
      rawgId: number;
      slug: string;
      name: string;
      released: string | null;
      screenshots: string[];
      platformFamilies: ('playstation' | 'xbox' | 'nintendo')[];
      added: number;
      isDlc: boolean; // Phase 5.5: DLC 여부
      parentRawgId?: number; // Phase 5.5: 부모 게임 RAWG ID
    }> = [];
    const seen = new Set<string>();

    const unifiedPlatforms = [
      ...RAWG_PLATFORM_IDS.playstation,
      ...RAWG_PLATFORM_IDS.xbox,
      ...RAWG_PLATFORM_IDS.nintendo,
    ].join(',');

    const target =
      limitMonths && limitMonths > 0 ? months.slice(0, limitMonths) : months;

    // 1단계: 월별 데이터 수집
    for (const [year, month] of target) {
      const params = buildMonthlyParams(year, month, { ordering, metacritic });
      const games: RawgGameSearchResult[] =
        await this.rawgApiService.searchGamesByPlatform('', {
          platforms: unifiedPlatforms,
          dates: params.dates,
          page_size: params.page_size,
          ordering: params.ordering,
          metacritic: params.metacritic,
        });

      if (!games?.length) {
        this.logger.warn(
          `⚠️ [RAWG] ${year}-${String(month).padStart(2, '0')} 월: 결과 없음`,
        );
        await this.delay(RAWG_COLLECTION.requestDelayMs);
        continue;
      }

      for (const g of games) {
        const key = String(g?.id || g?.slug || '');
        if (!key || seen.has(key)) continue;

        // 인기도 임계값: added 없으면 통과, 있으면 threshold 이상만
        const added = g.added ?? 0;
        const pass =
          g.added == null ? true : added >= RAWG_COLLECTION.popularityThreshold;
        if (!pass) continue;

        const families = extractPlatformFamilies(g.platforms || []);

        // ===== Phase 5.5: DLC 감지 및 부모 게임 조회 =====
        let isDlc = false;
        let parentRawgId: number | undefined;

        if (g.parent_games_count && g.parent_games_count > 0) {
          this.logger.debug(
            `🔍 [RAWG-DLC] DLC 후보 감지 - ${g.name} (parent_games_count: ${g.parent_games_count})`,
          );
          try {
            const parentGames = await this.rawgApiService.getParentGames(g.id);
            if (parentGames.length > 0) {
              isDlc = true;
              parentRawgId = parentGames[0].id; // 첫 번째 부모 게임 사용
              this.logger.log(
                `✅ [RAWG-DLC] DLC 확정 - ${g.name} → 부모: ${parentGames[0].name} (rawg_id: ${parentRawgId})`,
              );
            }
          } catch (error) {
            this.logger.warn(
              `⚠️ [RAWG-DLC] 부모 게임 조회 실패 - ${g.name}: ${error.message}`,
            );
            // 실패 시 DLC가 아닌 것으로 간주하고 계속 진행
          }
        }

        rawResults.push({
          rawgId: g.id,
          slug: g.slug,
          name: g.name,
          screenshots:
            g.short_screenshots?.slice(0, 5).map((s: any) => s.image) || [],
          released: g.released ?? null,
          platformFamilies: families,
          added,
          isDlc, // DLC 여부
          parentRawgId, // 부모 게임 RAWG ID (DLC일 때만 존재)
        });
        seen.add(key);
      }

      await this.delay(RAWG_COLLECTION.requestDelayMs);
    }

    this.logger.log(
      `✨ [RAWG] 월 단위 통합 수집 완료 — unique: ${rawResults.length}`,
    );

    // 2단계: ProcessedGameData 형식으로 변환 (Phase 4: YouTube 트레일러 조회 포함)
    const processedData: ProcessedGameData[] = [];
    for (const raw of rawResults) {
      const gameData = await this.mapToProcessedGameData(raw);
      processedData.push(gameData);
    }

    return processedData;
  }

  /**
   * RAWG 원시 데이터를 ProcessedGameData 형식으로 변환
   * Phase 4: 인기도 40점 이상 게임은 YouTube 트레일러 조회
   * Phase 5.5: DLC 메타데이터 포함
   * ✅ 수정: RAWG API 상세 정보 조회 및 game_detail 전체 필드 매핑
   */
  private async mapToProcessedGameData(raw: {
    rawgId: number;
    slug: string;
    screenshots: any;
    name: string;
    released: string | null;
    platformFamilies: ('playstation' | 'xbox' | 'nintendo')[];
    added: number;
    isDlc: boolean;
    parentRawgId?: number;
  }): Promise<ProcessedGameData> {
    // 출시일 파싱
    const releaseDate = raw.released ? new Date(raw.released) : undefined;
    const now = new Date();
    const comingSoon = releaseDate ? releaseDate > now : false;

    // 인기도 계산 (RAWG added 기반)
    const popularityScore = PopularityCalculator.calculateRawgPopularity(
      raw.added,
    );

    // 출시 상태 판단
    let releaseStatus: ReleaseStatus;
    if (!releaseDate) {
      releaseStatus = ReleaseStatus.TBA;
    } else if (comingSoon) {
      releaseStatus = ReleaseStatus.COMING_SOON;
    } else {
      releaseStatus = ReleaseStatus.RELEASED;
    }

    // ===== Phase 5.5: 플랫폼 타입 추가 =====
    // RAWG는 콘솔 게임만 수집하므로 첫 번째 패밀리를 platformType으로 사용
    const platformType = raw.platformFamilies[0] || 'playstation';

    // ===== ✅ RAWG API 상세 정보 조회 (인기도 40점 이상, DLC 아닐 때만) =====
    let rawgDetails: any = null;
    let youtubeVideoUrl: string | undefined;

    if (!raw.isDlc && popularityScore >= 40) {
      try {
        // RAWG API 상세 정보 조회
        rawgDetails = await this.rawgApiService.getGameDetails(raw.rawgId);
        // YouTube 트레일러 조회 (Phase 4)
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
      } catch (error) {
        this.logger.warn(
          `⚠️ [RAWG Details] 상세 정보 조회 실패 - ${raw.name}: ${error.message}`,
        );
      }
    }

    // ===== ✅ game_detail 전체 필드 매핑 =====
    const details =
      !raw.isDlc && popularityScore >= 40 && rawgDetails
        ? {
            screenshots: raw.screenshots,
            videoUrl: youtubeVideoUrl, // YouTube 우선 (RAWG는 비디오 URL 제공 안 함)
            description: rawgDetails.description_raw || rawgDetails.description,
            website: rawgDetails.website || undefined,
            genres: rawgDetails.genres?.map((g: any) => g.name) || [],
            tags: rawgDetails.tags?.slice(0, 10).map((t: any) => t.name) || [],
            supportLanguages: [], // RAWG는 언어 정보 제공 안 함
            metacriticScore: rawgDetails.metacritic || undefined,
            opencriticScore: undefined, // RAWG는 OpenCritic 제공 안 함
            rawgAdded: raw.added,
            platformType: 'console' as const, // ✅ 타입 수정: RAWG는 콘솔 게임만 수집
          }
        : undefined;

    // ===== ✅ game_release 정보 생성 (콘솔 게임) =====
    const releases = !raw.isDlc
      ? raw.platformFamilies.map((family) => {
          // 플랫폼 매핑 (Platform enum 준수)
          let platform: any;
          let store: any;
          switch (family) {
            case 'playstation':
              platform = 'playstation' as const;
              store = 'psn' as const;
              break;
            case 'xbox':
              platform = 'xbox' as const;
              store = 'xbox' as const;
              break;
            case 'nintendo':
              platform = 'nintendo' as const;
              store = 'nintendo' as const;
              break;
            default:
              platform = family;
              store = family;
          }

          return {
            platform,
            store,
            storeAppId: raw.rawgId.toString(), // RAWG ID 사용
            storeUrl: `https://rawg.io/games/${raw.slug}`,
            releaseDateDate: releaseDate,
            releaseDateRaw: raw.released ?? undefined,
            releaseStatus,
            comingSoon,
            currentPriceCents: undefined, // RAWG는 가격 정보 제공 안 함
            isFree: false,
            followers: undefined, // RAWG는 팔로워 정보 제공 안 함
            reviewsTotal: rawgDetails?.reviews_count || undefined,
            reviewScoreDesc: rawgDetails?.rating
              ? `${rawgDetails.rating}/5`
              : undefined,
            dataSource: 'rawg' as const, // ✅ 타입 수정: 리터럴 타입 명시
          };
        })
      : undefined;

    return {
      name: raw.name,
      slug: raw.slug,
      rawgId: raw.rawgId,
      gameType: GameType.GAME, // RAWG 데이터는 기본적으로 GAME으로 분류

      // ===== Phase 5.5: DLC 메타데이터 =====
      isDlc: raw.isDlc, // DLC 여부 (parent_games_count > 0 감지)
      parentRawgId: raw.parentRawgId, // 부모 게임 RAWG ID (DLC일 때만 존재)
      platformType, // 'playstation' | 'xbox' | 'nintendo'

      releaseDate,
      releaseDateRaw: raw.released ?? undefined,
      releaseStatus,
      comingSoon,
      popularityScore,
      platformsSummary: raw.platformFamilies, // 정규화된 패밀리명 그대로 사용

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

  private delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
