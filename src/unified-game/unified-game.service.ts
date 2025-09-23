import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { RawgService } from '../rawg/rawg.service';
import { StreamlinedSteamService } from '../steam/steam.service';
import { YouTubeService } from '../youtube/youtube.service';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
import {
  GameCalendarData,
  MonthlyUnifiedGameResult,
  UnifiedGameOptions,
  PlatformProcessingInfo,
  SteamScreenshot,
  SteamReviewData,
  StoreLinks,
} from '../types/game-calendar-unified.types';
import { GameNameUtils } from '../utils/game-name.utils';

/**
 * 통합 게임 처리 서비스
 * user_request.md 명세 완전 구현: RAWG + Steam + Reviews 하나의 논리로 통합
 *
 * 핵심 원칙:
 * - 하나의 논리 프로세스로 동작
 * - PC 게임: RAWG + Steam 통합 + 리뷰
 * - 콘솔 전용: RAWG만 사용
 * - DLC 필터링: parent_count 활용
 * - 최종 API: save/get 두 가지만
 */
@Injectable()
export class UnifiedGameService {
  private readonly logger = new Logger(UnifiedGameService.name);

  // 🎯 DB 기반 데이터 관리 (메모리 캐시 제거)
  // private batchDetailsCache = new Map<number, any>();
  // private batchStoresCache = new Map<number, any>();
  // 주 1회 스케줄링에는 메모리 캐시가 부적합함

  constructor(
    @InjectRepository(Game)
    private gameRepository: Repository<Game>,
    private dataSource: DataSource,
    private readonly rawgService: RawgService,
    private readonly steamService: StreamlinedSteamService,
    private readonly youtubeService: YouTubeService,
  ) {}

  /**
   * 🎯 메인 메서드: 월별 통합 게임 데이터 처리
   * GET API와 save API의 공통 로직
   */
  async processGamesForMonth(
    month: string,
    options: UnifiedGameOptions = {},
  ): Promise<MonthlyUnifiedGameResult> {
    const startTime = Date.now();
    this.logger.log(`${month} 월별 통합 게임 처리 시작`);

    // 기본 옵션 설정
    const mergedOptions: Required<UnifiedGameOptions> = {
      max_games: 20,
      enable_steam_integration: true,
      min_popularity: 3,
      include_early_access: true,
      steam_timeout: 10000,
      ...options,
    };

    try {
      // === 1단계: RAWG 데이터 수집  ===
      this.logger.debug(`1단계: RAWG에서 ${month} 게임 수집 중...`);
      const rawgResult = await this.rawgService.getMonthlyGames(
        month,
        Math.max(mergedOptions.max_games),
      );

      const finalGames = rawgResult.games.slice(0, mergedOptions.max_games);

      // === 1.5단계: DB 기반 기존 데이터 확인 ===
      this.logger.debug(
        `1.5단계: DB에서 기존 데이터 확인 중... (${finalGames.length}개 게임)`,
      );
      const existingGames = await this.checkExistingGamesInDB(
        finalGames.map((g) => g.id),
      );

      // === 2단계: 플랫폼별 통합 처리 ===
      this.logger.debug(`2단계: 플랫폼별 데이터 통합 중...`);
      const processedGames: GameCalendarData[] = [];
      let pcGamesCount = 0;
      let consoleGamesCount = 0;
      let steamIntegratedCount = 0;

      for (const rawgGame of finalGames) {
        try {
          // 기존 데이터 확인 및 업데이트 여부 판단
          const existingGame = existingGames.get(rawgGame.id);
          if (existingGame && !this.shouldUpdateGame(existingGame, rawgGame)) {
            this.logger.debug(`게임 업데이트 불필요, 스킵: ${rawgGame.name}`);
            // 기존 데이터를 다시 매핑하여 반환 형식에 맞촤 추가
            const existingGameData =
              await this.mapExistingGameToCalendarData(existingGame);
            processedGames.push(existingGameData);

            // 통계 카운트 (기존 데이터 기반)
            if (
              existingGameData.platform_type === 'pc' ||
              existingGameData.platform_type === 'mixed'
            ) {
              pcGamesCount++;
            }
            if (
              existingGameData.platform_type === 'console' ||
              existingGameData.platform_type === 'mixed'
            ) {
              consoleGamesCount++;
            }
            if (existingGameData.steam_integrated) {
              steamIntegratedCount++;
            }
            continue; // 다음 게임으로
          }

          // 새로운 데이터 처리 또는 업데이트 필요
          this.logger.debug(
            existingGame
              ? `게임 업데이트 필요: ${rawgGame.name}`
              : `새로운 게임 처리: ${rawgGame.name}`,
          );

          const unifiedGame = await this.processUnifiedGameData(
            rawgGame,
            mergedOptions,
          );
          processedGames.push(unifiedGame);

          // 통계 카운트
          if (
            unifiedGame.platform_type === 'pc' ||
            unifiedGame.platform_type === 'mixed'
          ) {
            pcGamesCount++;
          }
          if (
            unifiedGame.platform_type === 'console' ||
            unifiedGame.platform_type === 'mixed'
          ) {
            consoleGamesCount++;
          }
          if (unifiedGame.steam_integrated) {
            steamIntegratedCount++;
          }
        } catch (error) {
          this.logger.error(
            `게임 통합 처리 실패: ${rawgGame.name}`,
            error.message,
          );
        }
      }

      // 처리 완료 로그
      this.logger.debug('월별 게임 처리 완료');

      const processingTime = Date.now() - startTime;

      this.logger.log(
        `${month} 통합 게임 처리 완료: ${processedGames.length}개 (PC: ${pcGamesCount}, 콘솔: ${consoleGamesCount}, Steam 통합: ${steamIntegratedCount}개) - ${processingTime}ms`,
      );

      return {
        month,
        total_games: processedGames.length,
        pc_games: pcGamesCount,
        console_games: consoleGamesCount,
        steam_integrated_games: steamIntegratedCount,
        games: processedGames,
        collection_stats: {
          rawg_api_calls: rawgResult.page || 1,
          steam_api_calls: steamIntegratedCount * 3, // 검색 + appDetails + 리뷰
          steam_success_rate:
            pcGamesCount > 0 ? (steamIntegratedCount / pcGamesCount) * 100 : 0,
          processing_time_ms: processingTime,
          dlc_filtered: 0, // DLC 필터링은 프론트엔드에서 처리
        },
      };
    } catch (error) {
      this.logger.error(`${month} 통합 게임 처리 실패:`, error.message);
      throw new Error(`월별 통합 게임 처리 실패: ${error.message}`);
    }
  }

  /**
   * 🔄 개별 게임 통합 처리
   * 플랫폼별 전략에 따라 RAWG + Steam + Reviews 통합
   */
  private async processUnifiedGameData(
    rawgGame: any,
    options: Required<UnifiedGameOptions>,
  ): Promise<GameCalendarData> {
    // 플랫폼 분석 및 전략 결정
    const platformInfo = this.analyzePlatformStrategy(rawgGame.platforms);

    if (
      platformInfo.steamEligible &&
      options.enable_steam_integration &&
      platformInfo.strategy === 'steam-enhanced'
    ) {
      // PC 게임: Steam 통합 처리
      return await this.processWithSteamIntegration(rawgGame, options);
    } else {
      // 콘솔 전용: RAWG만 사용
      return await this.processRawgOnlyData(rawgGame);
    }
  }

  /**
   * 🎮 Steam 통합 처리 (PC 게임)
   */
  private async processWithSteamIntegration(
    rawgGame: any,
    options: Required<UnifiedGameOptions>,
  ): Promise<GameCalendarData> {
    try {
      this.logger.debug(`Steam 통합 처리 시작: ${rawgGame.name}`);

      // 0. 재시도 로직을 포함한 상세 정보 사용 (parents_count, additions_count 포함)
      const detailedGame =
        (await this.getDetailsWithRetry(rawgGame.id)) || rawgGame;

      // 1. RAWG 우선 검증: parentCount, additionsCount 확인 (상세 정보에서)
      const parentCount = detailedGame.parents_count || 0;
      const additionsCount = detailedGame.additions_count || 0;

      // 2. 게임명 분석 (항상 수행)
      const nameAnalysis = GameNameUtils.analyzeGameName(rawgGame.name);

      // 3. 조건부 Steam 검색 전략: RAWG 데이터 기반 결정
      let searchName: string;
      let searchStrategy: string;

      if (parentCount > 0) {
        // DLC/자식 게임: 정리된 게임명 사용
        searchName = nameAnalysis.cleanedName;
        searchStrategy = 'cleaned_for_dlc';
        this.logger.debug(
          `DLC/자식 게임 검색: ${rawgGame.name} → ${searchName} (parents: ${parentCount})`,
        );
      } else if (additionsCount > 0) {
        // 본편 게임 (추가 콘텐츠 보유): 원본명 사용
        searchName = rawgGame.name;
        searchStrategy = 'original_for_main_game';
        this.logger.debug(
          `본편 게임 검색: ${rawgGame.name} (원본명 사용, additions: ${additionsCount})`,
        );
      } else {
        // 독립 게임: 원본명 사용
        searchName = rawgGame.name;
        searchStrategy = 'original_for_standalone';
        this.logger.debug(
          `독립 게임 검색: ${rawgGame.name} (원본명 사용, parents: ${parentCount}, additions: ${additionsCount})`,
        );
      }

      // 4. Steam ID 검색 (조건부 정리된 게임명 사용)
      const steam_idResult = await this.steamService.findSteamId(searchName);
      if (!steam_idResult.success || !steam_idResult.steam_id) {
        this.logger.debug(
          `Steam ID 검색 실패 (${searchStrategy}): ${rawgGame.name}`,
        );

        // Fallback: 원본명으로 재시도 (정리된 이름으로 실패한 경우)
        if (searchStrategy === 'cleaned_for_dlc') {
          this.logger.debug(`원본명으로 재시도: ${rawgGame.name}`);
          const fallbackResult = await this.steamService.findSteamId(
            rawgGame.name,
          );
          if (fallbackResult.success && fallbackResult.steam_id) {
            // 원본명으로 성공하면 계속 진행
            steam_idResult.success = true;
            steam_idResult.steam_id = fallbackResult.steam_id;
            searchStrategy = 'fallback_original';
            this.logger.debug(`원본명 재시도 성공: ${rawgGame.name}`);
          }
        }

        if (!steam_idResult.success || !steam_idResult.steam_id) {
          return await this.processRawgOnlyData(rawgGame);
        }
      }

      // 5. Steam 게임 데이터 수집
      const steam_data = await this.steamService.getGameCalendarData(
        steam_idResult.steam_id,
        { timeout: options.steam_timeout },
      );
      if (!steam_data) {
        this.logger.debug(`Steam 데이터 조회 실패: ${rawgGame.name}`);
        return await this.processRawgOnlyData(rawgGame);
      }

      // 6. Steam 리뷰 추가
      const steamReviews = await this.steamService.getSteamReviews(
        steam_idResult.steam_id,
      );

      // 7. RAWG + Steam 데이터 병합
      const unifiedData = await this.mergeRawgAndSteamData(
        rawgGame,
        steam_data,
        steamReviews,
        nameAnalysis,
      );

      // 8. 최종 DLC 구분 분석 (RAWG + Steam + 게임명 통합 분석, 상세 정보 사용)
      const gameTypeAnalysis = await this.analyzeGameTypeUnified(
        detailedGame,
        steam_data,
        nameAnalysis,
      );
      this.logger.debug(
        `게임 타입 분석 결과: ${rawgGame.name} → ${gameTypeAnalysis.game_type} (신뢰도: ${gameTypeAnalysis.confidence})`,
      );

      // 9. 최종 분석 결과 적용
      unifiedData.is_dlc = !gameTypeAnalysis.is_main_game;
      unifiedData.game_type = gameTypeAnalysis.game_type;
      unifiedData.game_type_confidence = gameTypeAnalysis.confidence;
      unifiedData.game_type_reason = gameTypeAnalysis.reason;
      this.logger.debug(
        `Steam 통합 처리 성공: ${rawgGame.name} → ${steam_data.korea_name || steam_data.original_name}`,
      );

      return unifiedData;
    } catch (error) {
      this.logger.warn(`Steam 통합 처리 실패: ${rawgGame.name}`, error.message);
      return await this.processRawgOnlyData(rawgGame);
    }
  }

  /**
   * 🎯 RAWG 전용 처리 (콘솔 게임 또는 Steam 실패)
   */
  private async processRawgOnlyData(rawgGame: any): Promise<GameCalendarData> {
    // 0. 재시도 로직을 포함한 상세 정보 사용 (parents_count, additions_count 포함)
    const detailedGame =
      (await this.getDetailsWithRetry(rawgGame.id)) || rawgGame;

    // 1. 게임명 분석
    const nameAnalysis = GameNameUtils.analyzeGameName(rawgGame.name);
    this.logger.debug(
      `RAWG 전용 게임명 분석: ${rawgGame.name} (DLC패턴: ${nameAnalysis.patterns.isDlc})`,
    );

    // 2. RAWG 추가 정보 수집 (재시도 로직 포함)
    const [storeLinks, details, video] = await Promise.all([
      this.getStoreLinksWithRetry(
        rawgGame.id,
        rawgGame.name,
        rawgGame.platforms,
        rawgGame.stores,
      ),
      this.getDetailsWithRetry(rawgGame.id),
      this.getYouTubeTrailer(rawgGame.name),
    ]);

    // 3. 기본 데이터 객체 생성
    const baseData = {
      // === RAWG 기본 정보 ===
      rawg_id: rawgGame.id,
      name: rawgGame.name,
      required_age: '', // Steam에서만 제공
      released: rawgGame.released,
      tba: rawgGame.tba,
      platforms: this.normalizePlatforms(rawgGame.platforms),
      genres: rawgGame.genres?.map((g: any) => g.name) || [],
      tags: (rawgGame.tags || [])
        .filter((t: any) => t.language === 'eng')
        .map((t: any) => t.name)
        .slice(0, 10),
      early_access:
        rawgGame.tags?.some(
          (t: any) => t.name.toLowerCase() === 'early access',
        ) || false,
      image: rawgGame.background_image || '',

      // === 인기도 및 미디어 ===
      added: rawgGame.added,
      added_by_status: rawgGame.added_by_status,
      screenshots:
        rawgGame.short_screenshots?.slice(1).map((item: any) => item.image) ||
        [],

      // === 평점 및 등급 ===
      esrb_rating: rawgGame.esrb_rating?.name || null,
      rating: rawgGame.rating,
      ratings_count: rawgGame.ratings_count,
      description: rawgGame.description_raw,

      // === Steam 전용 데이터 (없음) ===
      metacritic: undefined,
      categories: [],

      // === 개발사/배급사 정보 ===
      slug_name: details?.slugName,
      website: details?.website,
      developers: details?.developers || [],
      publishers: details?.publishers || [],

      // === 링크 및 미디어 ===
      store_links: storeLinks,
      video,

      // === Steam 리뷰 관련 (없음) ===
      review_score: undefined,
      review_score_desc: undefined,
      total_positive: undefined,
      total_negative: undefined,
      total_reviews: undefined,

      // === Steam 통합 필드들 (없음) ===
      steam_id: undefined,
      original_name: undefined,
      korea_name: undefined,
      steam_type: undefined,
      price: undefined,
      is_full_game: undefined,
      dlc_list: undefined,
      is_free: undefined,

      // === 메타 정보 ===
      platform_type: this.determinePlatformType(rawgGame.platforms),
      steam_integrated: false,
    };

    // 4. 최종 DLC 구분 분석 (RAWG + 게임명 분석, 상세 정보 사용)
    const gameTypeAnalysis = await this.analyzeGameTypeUnified(
      detailedGame,
      undefined,
      nameAnalysis,
    );
    this.logger.debug(
      `RAWG 전용 게임 타입 분석: ${rawgGame.name} → ${gameTypeAnalysis.game_type} (신뢰도: ${gameTypeAnalysis.confidence})`,
    );

    // 5. 최종 분석 결과 적용하여 반환
    return {
      ...baseData,
      // === DLC 관련 (통합 분석 결과) ===
      is_dlc: !gameTypeAnalysis.is_main_game,
      game_type: gameTypeAnalysis.game_type,
      game_type_confidence: gameTypeAnalysis.confidence,
      game_type_reason: gameTypeAnalysis.reason,
    };
  }

  /**
   * 🎮 통합 DLC 구분 로직 (후처리)
   * RAWG + Steam + 게임명 분석을 종합하여 최종 판별
   */
  private async analyzeGameTypeUnified(
    rawgGame: any,
    steamData?: any,
    nameAnalysis?: any,
  ) {
    const additionsCount = rawgGame.additions_count || 0;
    const parentCount = rawgGame.parents_count || 0; // 복수형 수정!

    // 🥇 RAWG parent_count > 0 → DLC/에디션/포트 (가장 신뢰할 만함)
    if (parentCount > 0) {
      const gameType: 'dlc' | 'edition' | 'port' = nameAnalysis?.patterns.isDlc
        ? 'dlc'
        : nameAnalysis?.patterns.isEdition
          ? 'edition'
          : 'port';

      return {
        game_type: gameType,
        confidence: 0.98,
        reason: `RAWG 자식 게임 (${parentCount}개의 부모 게임 존재) - ${gameType}로 분류`,
        is_main_game: gameType === 'edition', // 에디션은 본편으로 취급
      };
    }

    // 🥈 RAWG additions_count > 0 → 본편 확정
    if (additionsCount > 0) {
      return {
        game_type: 'main_game' as const,
        confidence: 0.95,
        reason: `RAWG 본편 게임 (${additionsCount}개의 추가 콘텐츠 보유)`,
        is_main_game: true,
      };
    }

    // 🥉 Steam DLC 역검색 분석 (정교한 판별)
    if (steamData) {
      const steamType = (
        steamData.steam_type ||
        steamData.type ||
        ''
      ).toLowerCase();
      const dlcList = steamData.dlc_list || steamData.dlc || [];
      const hasFullgameInfo = !!(steamData.fullgame_info || steamData.fullgame);

      // Steam 공식 DLC 타입
      if (steamType === 'dlc') {
        return {
          game_type: 'dlc' as const,
          confidence: 0.95,
          reason: `Steam 공식 DLC 타입${hasFullgameInfo ? ' (본편 정보 포함)' : ''}`,
          is_main_game: false,
        };
      }

      // Steam이 game 타입이지만 DLC 목록이 있는 경우 → 역검색 수행
      if (steamType === 'game' && dlcList.length > 0) {
        // DLC 역검색: 현재 게임이 본편의 DLC 목록에 포함되어 있는지 확인
        const dlcCheckResult = await this.steamService.checkIfGameIsDlcInList(
          dlcList,
          rawgGame.name,
        );

        if (dlcCheckResult.isDlc) {
          return {
            game_type: 'dlc' as const,
            confidence: 0.92,
            reason: `Steam DLC 역검색 성공: ${dlcCheckResult.reason}`,
            is_main_game: false,
          };
        }

        // DLC 목록에 없으면 실제 본편 게임
        return {
          game_type: 'main_game' as const,
          confidence: 0.88,
          reason: `Steam 본편 게임 (${dlcList.length}개 DLC 보유, 역검색 결과: ${dlcCheckResult.reason})`,
          is_main_game: true,
        };
      }

      // Steam이 game 타입이고 DLC 목록이 없는 경우
      if (steamType === 'game') {
        // 게임명 패턴으로 추가 검증
        if (nameAnalysis?.patterns.isDlc) {
          return {
            game_type: 'dlc' as const,
            confidence: 0.75,
            reason: `Steam game 타입이지만 게임명이 DLC 패턴: ${nameAnalysis.extractedInfo.subtitle || 'DLC 키워드 포함'}`,
            is_main_game: false,
          };
        }

        // 에디션 패턴 검사 추가 (GOTY, Complete 등)
        if (nameAnalysis?.patterns.isEdition) {
          return {
            game_type: 'edition' as const,
            confidence: 0.82,
            reason: `Steam 에디션 게임: ${nameAnalysis.extractedInfo.detectedKeywords.join(', ')}`,
            is_main_game: true,
          };
        }

        return {
          game_type: 'standalone' as const,
          confidence: 0.85,
          reason: 'Steam 단독 게임 (DLC 없음)',
          is_main_game: true,
        };
      }
    }

    // 🏅 게임명 패턴 분석
    if (nameAnalysis?.patterns.isDlc) {
      return {
        game_type: 'dlc' as const,
        confidence: 0.7,
        reason: `게임명 DLC 패턴: ${nameAnalysis.extractedInfo.subtitle || 'DLC 키워드 포함'}`,
        is_main_game: false,
      };
    }

    if (nameAnalysis?.patterns.isEdition) {
      return {
        game_type: 'edition' as const,
        confidence: 0.8,
        reason: `게임명 에디션 패턴: ${nameAnalysis.extractedInfo.detectedKeywords.join(', ')}`,
        is_main_game: true,
      };
    }

    // 🎯 기본값: 단독 본편
    return {
      game_type: 'standalone' as const,
      confidence: 0.85,
      reason: '단독 본편 게임 (추가 콘텐츠/부모 게임/특수 패턴 없음)',
      is_main_game: true,
    };
  }

  /**
   * 🔀 RAWG + Steam 데이터 병합
   * user_request.md 명세에 따른 우선순위 적용
   */
  private async mergeRawgAndSteamData(
    rawgGame: any,
    steam_data: any,
    steamReviews: any,
    nameAnalysis: any,
  ): Promise<GameCalendarData> {
    // 기본 RAWG 데이터 생성 (재시도 로직 포함)
    const [storeLinks, details, video] = await Promise.all([
      this.getStoreLinksWithRetry(
        rawgGame.id,
        rawgGame.name,
        rawgGame.platforms,
        rawgGame.stores,
      ),
      this.getDetailsWithRetry(rawgGame.id),
      this.getYouTubeTrailer(rawgGame.name),
    ]);

    const baseData: GameCalendarData = {
      // === RAWG 기본 정보 ===
      rawg_id: rawgGame.id,
      name: rawgGame.name,
      required_age: '', // Steam에서만 제공
      released: rawgGame.released,
      tba: rawgGame.tba,
      platforms: this.normalizePlatforms(rawgGame.platforms),
      genres: rawgGame.genres?.map((g: any) => g.name) || [],
      tags: (rawgGame.tags || [])
        .filter((t: any) => t.language === 'eng')
        .map((t: any) => t.name)
        .slice(0, 10),
      early_access:
        rawgGame.tags?.some(
          (t: any) => t.name.toLowerCase() === 'early access',
        ) || false,
      image: rawgGame.background_image || '',

      // === 인기도 및 미디어 ===
      added: rawgGame.added,
      added_by_status: rawgGame.added_by_status,
      screenshots:
        rawgGame.short_screenshots?.slice(1).map((item: any) => item.image) ||
        [],

      // === 평점 및 등급 ===
      esrb_rating: rawgGame.esrb_rating?.name || null,
      rating: rawgGame.rating,
      ratings_count: rawgGame.ratings_count,
      description: rawgGame.description_raw,

      // === Steam 전용 데이터 (기본값) ===
      metacritic: undefined,
      categories: [],

      // === 개발사/배급사 정보 ===
      slug_name: details?.slugName,
      website: details?.website,
      developers: details?.developers || [],
      publishers: details?.publishers || [],

      // === 링크 및 미디어 ===
      store_links: storeLinks,
      video,

      // === Steam 리뷰 관련 (기본값) ===
      review_score: undefined,
      review_score_desc: undefined,
      total_positive: undefined,
      total_negative: undefined,
      total_reviews: undefined,

      // === Steam 통합 필드들 (기본값) ===
      steam_id: undefined,
      original_name: undefined,
      korea_name: undefined,
      steam_type: undefined,
      price: undefined,
      is_full_game: undefined,
      dlc_list: undefined,
      is_free: undefined,

      // === DLC 관련 (임시값, 후에 수정됨) ===
      is_dlc: false,

      // === 메타 정보 ===
      platform_type: this.determinePlatformType(rawgGame.platforms),
      steam_integrated: false,
    };

    // Steam 카테고리 처리 (description만 저장)
    const steamCategories =
      steam_data.categories
        ?.map((cat: any) =>
          typeof cat === 'string' ? cat : cat.description || '',
        )
        .filter(Boolean) || [];

    // user_request.md 명세에 따른 Steam 데이터로 보강
    return {
      ...baseData,

      // === Steam 우선 데이터 ===
      required_age: steam_data.steam_id?.toString() || '',
      image: steam_data.image || baseData.image,
      screenshots:
        steam_data.screenshots?.length > 0
          ? steam_data.screenshots
          : baseData.screenshots,
      website: steam_data.website || baseData.website,
      developers:
        steam_data.developers?.length > 0
          ? steam_data.developers
          : baseData.developers,
      publishers:
        steam_data.publishers?.length > 0
          ? steam_data.publishers
          : baseData.publishers,

      // === Steam 전용 데이터 ===
      metacritic: undefined, // TODO: Steam appDetails에서 추출
      categories: steamCategories,

      // === Steam 리뷰 데이터 (직접 포함) ===
      review_score: steamReviews?.review_score || undefined,
      review_score_desc: steamReviews?.review_score_desc || undefined,
      total_positive: steamReviews?.total_positive || undefined,
      total_negative: steamReviews?.total_negative || undefined,
      total_reviews: steamReviews?.total_reviews || undefined,

      // === Steam 통합 필드들 (플랫 구조) ===
      steam_id: steam_data.steam_id,
      original_name: steam_data.original_name,
      korea_name: steam_data.korea_name,
      steam_type: steam_data.steam_type,
      price: steam_data.price || 'Unknown',
      is_full_game: steam_data.is_full_game,
      dlc_list: steam_data.dlc_list || [],
      is_free: steam_data.is_free,

      // === 메타 정보 ===
      steam_integrated: true,
    };
  }

  /**
   * 🎯 플랫폼 전략 분석
   * PC/콘솔 구분하여 적절한 처리 전략 결정
   */
  private analyzePlatformStrategy(platforms: any[]): PlatformProcessingInfo {
    const platformSlugs = platforms.map(
      (p) => p.platform?.slug?.toLowerCase() || p.toLowerCase(),
    );

    const hasPc = platformSlugs.some((slug) =>
      ['pc', 'macos', 'linux'].some((os) => slug.includes(os)),
    );

    const hasConsole = platformSlugs.some((slug) =>
      ['playstation', 'xbox', 'nintendo', 'switch'].some((console) =>
        slug.includes(console),
      ),
    );

    if (hasPc) {
      return {
        strategy: 'steam-enhanced',
        reason: 'PC 플랫폼 포함, Steam 데이터 통합 가능',
        steamEligible: true,
      };
    } else {
      return {
        strategy: 'rawg-only',
        reason: '콘솔 전용, RAWG 데이터만 사용',
        steamEligible: false,
      };
    }
  }

  /**
   * 🔧 유틸리티: 플랫폼 정규화
   */
  private normalizePlatforms(platforms: any[]): string[] {
    return Array.from(
      new Set(
        platforms.map((p) => {
          const slug = p.platform?.slug || p;

          if (slug.includes('playstation')) return 'PlayStation';
          if (slug.includes('xbox')) return 'Xbox';
          if (slug.includes('nintendo')) return 'Nintendo';
          if (['pc', 'macos', 'linux'].some((os) => slug.includes(os)))
            return 'PC';

          return slug; // 매핑 안 되면 원래 slug 유지
        }),
      ),
    );
  }

  /**
   * 🔧 유틸리티: 플랫폼 타입 결정
   */
  private determinePlatformType(platforms: any[]): 'pc' | 'console' | 'mixed' {
    const platformSlugs = platforms.map(
      (p) => p.platform?.slug?.toLowerCase() || p.toLowerCase(),
    );

    const hasPc = platformSlugs.some((slug) =>
      ['pc', 'macos', 'linux'].some((os) => slug.includes(os)),
    );

    const hasConsole = platformSlugs.some((slug) =>
      ['playstation', 'xbox', 'nintendo', 'switch'].some((console) =>
        slug.includes(console),
      ),
    );

    if (hasPc && hasConsole) return 'mixed';
    if (hasPc) return 'pc';
    return 'console';
  }

  /**
   * 🔧 유틸리티: YouTube 트레일러 조회
   */
  private async getYouTubeTrailer(
    gameName: string,
  ): Promise<string | undefined> {
    try {
      const videoId = await this.youtubeService.getSimpleTrailer(gameName);
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined;
    } catch (error) {
      this.logger.warn(
        `YouTube 트레일러 조회 실패: ${gameName}`,
        error.message,
      );
      return undefined;
    }
  }

  // === 🚀 배치 처리 및 캐싱 최적화 메서드들 ===

  /**
   * 🎯 DB에서 기존 게임 데이터 확인
   * 증분 업데이트를 위한 기존 데이터 체크
   */
  private async checkExistingGamesInDB(
    rawgIds: number[],
  ): Promise<Map<number, Game>> {
    if (rawgIds.length === 0) return new Map();

    this.logger.debug(`DB에서 기존 게임 데이터 확인: ${rawgIds.length}개`);

    const existingGames = await this.gameRepository.find({
      where: { rawg_id: In(rawgIds) },
      select: ['id', 'rawg_id', 'name', 'released', 'platforms', 'steam_id'],
    });

    const gameMap = new Map<number, Game>();
    existingGames.forEach((game) => {
      gameMap.set(game.rawg_id, game);
    });

    this.logger.debug(`DB에서 기존 게임 ${gameMap.size}개 발견`);
    return gameMap;
  }

  /**
   * 🚀 증분 업데이트를 위한 데이터 비교
   * 기존 DB 데이터와 비교하여 업데이트 필요 여부 판단
   */
  private shouldUpdateGame(existingGame: Game, newGameData: any): boolean {
    // 기본적인 비교 로직 - 주요 필드 변경 감지
    if (existingGame.name !== newGameData.name) return true;
    if (
      existingGame.released?.getTime() !==
      new Date(newGameData.released).getTime()
    )
      return true;
    if (
      JSON.stringify(existingGame.platforms) !==
      JSON.stringify(newGameData.platforms)
    )
      return true;

    // Steam 데이터 변경 감지
    if (existingGame.steam_id !== newGameData.steam_id) return true;

    // 기본적으로 업데이트가 필요하지 않다고 가정 (주 1회 스케줄링에 적합)
    // Steam ID가 새로 추가된 경우만 업데이트
    // 현재는 발견된 변경 사항이 있을 때만 업데이트

    return false;
  }

  /**
   * 🚀 API 재시도 로직
   * 네트워크 오류 시 자동 재시도
   */
  private async retryApiCall<T>(
    apiCall: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        this.logger.warn(
          `API 호출 시도 ${attempt}/${maxRetries} 실패:`,
          error.message,
        );

        if (attempt === maxRetries) {
          throw error; // 마지막 시도에서도 실패하면 예외 발생
        }

        // 지수적 백오프 (exponential backoff)
        const delay = delayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('최대 재시도 횟수 초과');
  }

  /**
   * 🚀 재시도 로직을 포함한 Details 조회
   */
  private async getDetailsWithRetry(gameId: number): Promise<any> {
    return this.retryApiCall(async () => {
      return await this.rawgService.getDetails(gameId);
    });
  }

  /**
   * 🚀 재시도 로직을 포함한 Store Links 조회
   */
  private async getStoreLinksWithRetry(
    gameId: number,
    gameName: string,
    platforms: any,
    stores: any,
  ): Promise<StoreLinks> {
    const storeData = await this.retryApiCall(async () => {
      return await this.rawgService.getStore(gameId);
    });

    return this.buildStoreLinks(gameId, gameName, platforms, stores, storeData);
  }

  /**
   * 🚀 스토어 링크 비드
   */
  private async buildStoreLinks(
    gameId: number,
    gameName: string,
    platforms: any,
    stores: any,
    storeData?: any,
  ): Promise<StoreLinks> {
    const STORE_KEYS = [
      'steam',
      'gog',
      'epic',
      'playstation',
      'xbox',
      'nintendo',
    ] as const;

    const STORE_ID_MAP: Record<number, keyof StoreLinks> = {
      1: 'steam',
      5: 'gog',
      11: 'epic',
    };

    const links: StoreLinks = {};
    const encodedName = encodeURIComponent(gameName);
    const slugs: string[] = (platforms ?? []).map((p: any) =>
      typeof p === 'string' ? p.toLowerCase() : p.platform.slug.toLowerCase(),
    );

    try {
      // 1) API에서 받은 스토어 데이터 사용
      if (storeData?.results) {
        storeData.results.forEach((r: any) => {
          const key = STORE_ID_MAP[r.store_id];
          if (key && !links[key] && r.url) links[key] = r.url;
        });
      }

      // 2) 남은 스토어는 플랫폼 기반 fallback
      for (const s of STORE_KEYS) {
        if (links[s]) continue;

        if (s === 'steam' && slugs.includes('pc'))
          links.steam = `https://store.steampowered.com/search/?term=${encodedName}`;
        if (s === 'playstation' && slugs.some((x) => x.includes('playstation')))
          links.playstation = `https://store.playstation.com/search/${encodedName}`;
        if (s === 'xbox' && slugs.some((x) => x.includes('xbox')))
          links.xbox = `https://www.xbox.com/ko-kr/Search/Results?q=${encodedName}`;
        if (
          s === 'nintendo' &&
          slugs.some((x) => x.includes('nintendo') || x.includes('switch'))
        )
          links.nintendo = `https://store.nintendo.co.kr/catalogsearch/result/?q=${encodedName}`;
      }

      return links;
    } catch (e: any) {
      this.logger.warn(`스토어 링크 조회 실패: ${gameName}`, e?.message ?? e);
      return {};
    }
  }

  /**
   * 🗑️ 더미 메서드 (호환성 유지)
   * 메모리 캐시가 제거되었으므로 빈 메서드
   */
  async clearBatchCache(): Promise<void> {
    this.logger.log('메모리 캐시가 제거되어 정리할 내용이 없음');
  }

  /**
   * 🔄 기존 게임 데이터를 캐렌더 데이터 형식으로 매핑
   */
  private async mapExistingGameToCalendarData(
    existingGame: Game,
  ): Promise<GameCalendarData> {
    // DB에서 게임 상세 정보 조회
    const gameDetail = await this.dataSource
      .getRepository(GameDetail)
      .findOne({ where: { game_id: existingGame.id } });

    return {
      // === RAWG 기본 정보 ===
      rawg_id: existingGame.rawg_id,
      name: existingGame.name,
      required_age: '', // Steam에서만 제공
      released: existingGame.released.toISOString().split('T')[0],
      tba: false,
      platforms: existingGame.platforms || [],
      genres: existingGame.genres || [],
      tags: gameDetail?.tags || [],
      early_access: gameDetail?.early_access || false,
      image: existingGame.image || '',

      // === 인기도 및 미디어 ===
      added: existingGame.added || 0,
      added_by_status: {},
      screenshots: gameDetail?.screenshots || [],

      // === 평점 및 등급 ===
      esrb_rating: gameDetail?.esrb_rating || null,
      rating: gameDetail?.rating || 0,
      ratings_count: gameDetail?.ratings_count || 0,
      description: gameDetail?.description || '',

      // === Steam 전용 데이터 ===
      metacritic: undefined,
      categories: [],

      // === 개발사/배급사 정보 ===
      slug_name: gameDetail?.slug_name || '',
      website: gameDetail?.website || existingGame.developers?.[0] || '',
      developers: existingGame.developers || [],
      publishers: existingGame.publishers || [],

      // === 링크 및 미디어 ===
      store_links: gameDetail?.store_links || {},
      video: undefined, // YouTube 데이터는 실시간 조회 필요

      // === Steam 리뷰 관련 ===
      review_score: undefined, // Steam review score는 숫자 타입이지만 DB에는 문자열로 저장되어 있음
      review_score_desc: existingGame.steam_review_score || undefined,
      total_positive: existingGame.steam_reviews_positive || undefined,
      total_negative:
        existingGame.steam_reviews_total && existingGame.steam_reviews_positive
          ? existingGame.steam_reviews_total -
            existingGame.steam_reviews_positive
          : undefined,
      total_reviews: existingGame.steam_reviews_total || undefined,

      // === Steam 통합 필드들 ===
      steam_id: existingGame.steam_id || undefined,
      original_name: existingGame.name,
      korea_name: existingGame.korea_name || undefined,
      steam_type: existingGame.steam_type || undefined,
      price: existingGame.steam_price || undefined,
      is_full_game: existingGame.steam_type === 'game',
      dlc_list: existingGame.dlc_list || undefined,
      is_free: existingGame.steam_price === '무료',

      // === DLC 관련 ===
      is_dlc: existingGame.steam_type === 'dlc',
      game_type: existingGame.steam_type === 'dlc' ? 'dlc' : 'main_game',
      game_type_confidence: 0.95,
      game_type_reason: 'DB에서 기존 데이터 사용',

      // === 메타 정보 ===
      platform_type: this.determinePlatformType(existingGame.platforms),
      steam_integrated: !!existingGame.steam_id,
    };
  }

  // === 🗄️ 데이터베이스 저장 메서드들 ===

  /**
   * 💾 통합 게임 데이터를 데이터베이스에 저장
   * save API용 메서드
   */
  async saveUnifiedGamesToDatabase(
    month: string,
    options?: UnifiedGameOptions,
  ): Promise<{
    saved: number;
    skipped: number;
    errors: number;
  }> {
    try {
      this.logger.log(`${month} 통합 게임 데이터 DB 저장 시작`);

      // 통합 데이터 처리
      const unifiedResult = await this.processGamesForMonth(month, options);
      const results = { saved: 0, skipped: 0, errors: 0 };

      // 각 게임을 DB에 저장
      for (const gameData of unifiedResult.games) {
        try {
          await this.saveUnifiedGameToDatabase(gameData);
          results.saved++;
          this.logger.debug(`게임 저장 완료: ${gameData.name}`);
        } catch (error) {
          if (error.code === '23505' || error.message?.includes('중복')) {
            results.skipped++;
            this.logger.debug(`게임 중복 건너뜀: ${gameData.name}`);
          } else {
            this.logger.error(
              `게임 저장 실패: ${gameData.name}`,
              error.message,
            );
            results.errors++;
          }
        }
      }

      this.logger.log(
        `${month} 통합 게임 DB 저장 완료: 저장 ${results.saved}개, 건너뜀 ${results.skipped}개, 오류 ${results.errors}개`,
      );

      return results;
    } catch (error) {
      this.logger.error(`통합 게임 DB 저장 실패:`, error.message);
      throw new Error(`통합 게임 DB 저장 실패: ${error.message}`);
    }
  }

  /**
   * 💾 개별 통합 게임 데이터 DB 저장 (증분 업데이트 지원)
   */
  private async saveUnifiedGameToDatabase(
    gameData: GameCalendarData,
  ): Promise<Game> {
    // 기존 데이터 체크
    const existing = await this.gameRepository.findOne({
      where: { rawg_id: gameData.rawg_id },
    });

    if (existing) {
      // 업데이트 필요성 판단
      if (!this.shouldUpdateGame(existing, gameData)) {
        this.logger.debug(`게임 업데이트 불필요: ${gameData.name}`);
        throw { code: '23505', message: '업데이트 불필요' };
      }

      // 업데이트 수행
      this.logger.debug(`게임 데이터 업데이트: ${gameData.name}`);
      return await this.updateExistingGameInDatabase(existing, gameData);
    }

    return await this.dataSource.transaction(async (manager) => {
      // Game Entity 생성 및 저장 (Steam 필드 포함)
      const game = new Game();
      game.rawg_id = gameData.rawg_id;
      game.name = gameData.name;
      game.released = new Date(gameData.released);
      game.platforms = gameData.platforms;
      game.genres = gameData.genres;
      game.added = gameData.added;
      game.image = gameData.image;
      game.developers = gameData.developers;
      game.publishers = gameData.publishers;

      // Steam 통합 필드들 (플랫 구조)
      game.steam_id = gameData.steam_id || undefined;
      game.korea_name = gameData.korea_name || undefined;
      game.steam_price = gameData.price || undefined;
      game.steam_type =
        gameData.steam_type ||
        (gameData.is_full_game === false ? 'dlc' : 'game');
      game.fullgame_info = undefined; // DLC의 경우 추후 본편 정보 추가
      game.dlc_list = gameData.dlc_list || undefined;

      // Steam 리뷰 데이터
      game.steam_reviews_positive = gameData.total_positive || undefined;
      game.steam_reviews_total = gameData.total_reviews || undefined;
      game.steam_review_score = gameData.review_score_desc || undefined;
      const savedGame = await manager.save(game);

      // GameDetail Entity 생성 및 저장
      const gameDetail = new GameDetail();
      gameDetail.game_id = savedGame.id;
      gameDetail.slug_name = gameData.slug_name || '';
      gameDetail.tags = gameData.tags || [];
      gameDetail.rating = gameData.rating || 0;
      gameDetail.early_access = gameData.early_access || false;
      gameDetail.ratings_count = gameData.ratings_count || 0;
      gameDetail.screenshots = Array.isArray(gameData.screenshots)
        ? gameData.screenshots.map((s) =>
            typeof s === 'string' ? s : (s as any).path_full || String(s),
          )
        : (gameData.screenshots as string[]) || [];
      gameDetail.store_links = gameData.store_links || {};
      gameDetail.esrb_rating = gameData.esrb_rating || undefined;
      gameDetail.description = gameData.description || undefined;
      gameDetail.website = gameData.website || undefined;
      await manager.save(gameDetail);

      return savedGame;
    });
  }

  /**
   * 🔄 기존 게임 데이터 업데이트
   */
  private async updateExistingGameInDatabase(
    existingGame: Game,
    newGameData: GameCalendarData,
  ): Promise<Game> {
    return await this.dataSource.transaction(async (manager) => {
      // Game Entity 업데이트
      existingGame.name = newGameData.name;
      existingGame.released = new Date(newGameData.released);
      existingGame.platforms = newGameData.platforms;
      existingGame.genres = newGameData.genres;
      existingGame.added = newGameData.added;
      existingGame.image = newGameData.image;
      existingGame.developers = newGameData.developers;
      existingGame.publishers = newGameData.publishers;

      // Steam 통합 필드들 업데이트
      existingGame.steam_id = newGameData.steam_id || existingGame.steam_id;
      existingGame.korea_name =
        newGameData.korea_name || existingGame.korea_name;
      existingGame.steam_price = newGameData.price || existingGame.steam_price;
      existingGame.steam_type =
        newGameData.steam_type || existingGame.steam_type;
      existingGame.dlc_list = newGameData.dlc_list || existingGame.dlc_list;

      // Steam 리뷰 데이터 업데이트
      existingGame.steam_reviews_positive =
        newGameData.total_positive || existingGame.steam_reviews_positive;
      existingGame.steam_reviews_total =
        newGameData.total_reviews || existingGame.steam_reviews_total;
      existingGame.steam_review_score =
        newGameData.review_score_desc || existingGame.steam_review_score;

      // 업데이트 완료 로그
      this.logger.debug(`Game 엔티티 업데이트 완료: ${newGameData.name}`);

      const updatedGame = await manager.save(existingGame);

      // GameDetail Entity 업데이트
      let gameDetail = await manager
        .getRepository(GameDetail)
        .findOne({ where: { game_id: existingGame.id } });

      if (!gameDetail) {
        // GameDetail이 없으면 새로 생성
        gameDetail = new GameDetail();
        gameDetail.game_id = existingGame.id;
      }

      gameDetail.slug_name =
        newGameData.slug_name || gameDetail.slug_name || '';
      gameDetail.tags = newGameData.tags || gameDetail.tags || [];
      gameDetail.rating = newGameData.rating || gameDetail.rating || 0;
      gameDetail.early_access =
        newGameData.early_access ?? gameDetail.early_access ?? false;
      gameDetail.ratings_count =
        newGameData.ratings_count || gameDetail.ratings_count || 0;
      gameDetail.screenshots = Array.isArray(newGameData.screenshots)
        ? newGameData.screenshots.map((s) =>
            typeof s === 'string' ? s : (s as any).path_full || String(s),
          )
        : gameDetail.screenshots || [];
      gameDetail.store_links =
        newGameData.store_links || gameDetail.store_links || {};
      gameDetail.esrb_rating =
        newGameData.esrb_rating || gameDetail.esrb_rating;
      gameDetail.description =
        newGameData.description || gameDetail.description;
      gameDetail.website = newGameData.website || gameDetail.website;

      await manager.save(gameDetail);

      this.logger.debug(`게임 데이터 업데이트 완료: ${newGameData.name}`);
      return updatedGame;
    });
  }
}
