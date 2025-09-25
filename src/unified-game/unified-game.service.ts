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
  StoreLinks,
} from '../types/game-calendar-unified.types';
import {
  GameAnalysisService,
  ClassificationContext,
} from '../utils/game-analysis';
import { PLATFORM_TYPES, LoggerHelper } from '../utils/game-utilities';
import { DataMapper } from '../utils/data-processing';
import { ErrorHandlerUtil } from '../common/utils/error-handler.util';

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
    // 🔄 통합 시스템: 메서드 시작 로깅은 NestJS 라이프사이클에서 자동 처리

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
      const rawgResult = await this.rawgService.getMonthlyGames(
        month,
        Math.max(mergedOptions.max_games),
      );

      const finalGames = rawgResult.games.slice(0, mergedOptions.max_games);

      // === 1.5단계: DB 기반 기존 데이터 확인 ===
      const existingGames = await this.checkExistingGamesInDB(
        finalGames.map((g) => g.id),
      );

      // === 2단계: 플랫폼별 통합 처리 ===
      const processedGames: GameCalendarData[] = [];
      let pcGamesCount = 0;
      let consoleGamesCount = 0;
      let steamIntegratedCount = 0;

      for (const rawgGame of finalGames) {
        try {
          // 기존 데이터 확인 및 업데이트 여부 판단
          const existingGame = existingGames.get(rawgGame.id);
          if (existingGame && !this.shouldUpdateGame(existingGame, rawgGame)) {
            // 기존 데이터를 다시 매핑하여 반환 형식에 맞촤 추가
            const existingGameData =
              await this.mapExistingGameToCalendarData(existingGame);
            processedGames.push(existingGameData);

            // 통계 카운트 (기존 데이터 기반)
            if (this.isPcCompatible(existingGameData.platform_type)) {
              pcGamesCount++;
            }
            if (this.isConsoleCompatible(existingGameData.platform_type)) {
              consoleGamesCount++;
            }
            if (existingGameData.steam_integrated) {
              steamIntegratedCount++;
            }
            continue; // 다음 게임으로
          }

          // 새로운 데이터 처리 또는 업데이트 필요

          const unifiedGame = await this.processUnifiedGameData(
            rawgGame,
            mergedOptions,
          );
          processedGames.push(unifiedGame);

          // 통계 카운트
          if (this.isPcCompatible(unifiedGame.platform_type)) {
            pcGamesCount++;
          }
          if (this.isConsoleCompatible(unifiedGame.platform_type)) {
            consoleGamesCount++;
          }
          if (unifiedGame.steam_integrated) {
            steamIntegratedCount++;
          }
        } catch (error) {
          // 🔄 비즈니스 로직 실패: 개별 게임 처리 실패는 전체 작업을 중단하지 않음
          // GlobalExceptionFilter에서 자동으로 로깅됨
          continue;
        }
      }

      const processingTime = Date.now() - startTime;
      // 🔄 통합 시스템: 완료 로깅은 ResponseInterceptor에서 자동 처리

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
      // 🔄 ErrorHandlerUtil 또는 GlobalExceptionFilter에서 자동 로깅 처리
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
      // 🔄 통합 시스템: Steam 통합 처리 시작 로깅 제거

      // 0. 재시도 로직을 포함한 상세 정보 사용 (parents_count, additions_count 포함)
      const detailedGame =
        (await this.getDetailsWithRetry(rawgGame.id)) || rawgGame;

      // 1. RAWG 우선 검증: parentCount, additionsCount 확인 (상세 정보에서)
      const parentCount = detailedGame.parents_count || 0;
      const additionsCount = detailedGame.additions_count || 0;

      // 2. 게임명 분석 및 분류 컨텍스트 구성
      const nameAnalysis = GameAnalysisService.analyzeGameName(rawgGame.name);

      // 3. Steam ID 검색을 위해 store_links 가져오기
      const storeLinksForSteam = await this.getStoreLinksWithRetry(
        rawgGame.id,
        rawgGame.name,
        rawgGame.platforms,
        rawgGame.stores,
      );

      // 4. 게임 분류 컨텍스트 구성
      const classificationContext: ClassificationContext = {
        rawgName: rawgGame.name,
        parentsCount: parentCount,
        additionsCount: additionsCount,
        hasStoreLink: !!storeLinksForSteam?.steam,
        nameAnalysis,
      };

      // 5. 초기 분류 및 검색 전략 수립
      const initialClassification = GameAnalysisService.classifyGame(
        classificationContext,
      );
      const searchStrategies = GameAnalysisService.generateSearchStrategies(
        classificationContext,
      );

      // 6. Steam ID 검색 (store_links 우선 + 다중 전략)
      const steam_idResult = await this.steamService.findSteamId(
        rawgGame.name,
        storeLinksForSteam,
        searchStrategies,
      );

      // 7. Steam ID 검색 실패 시 RAWG 전용 처리
      if (!steam_idResult.success || !steam_idResult.steam_id) {
        // 🚨 비즈니스 로직 실패: Steam ID 검색 실패
        this.logger.warn(`Steam ID 검색 실패: ${rawgGame.name} - ID 검색 실패`);
        return await this.processRawgOnlyData(rawgGame);
      }

      // 5. Steam 게임 데이터 수집
      const steam_data = await this.steamService.getGameCalendarData(
        steam_idResult.steam_id,
        { timeout: options.steam_timeout },
      );
      if (!steam_data) {
        // 🚨 비즈니스 로직 실패: Steam 데이터 조회 실패
        this.logger.warn(
          `Steam 데이터 조회 실패: ${rawgGame.name} (Steam ID: ${steam_idResult.steam_id})`,
        );
        return await this.processRawgOnlyData(rawgGame);
      }

      // 6. Steam 리뷰 추가
      const steamReviews = await this.steamService.getSteamReviews(
        steam_idResult.steam_id,
      );

      // 7. RAWG + Steam 데이터 병합 (이미 가져온 store_links 재사용)
      const unifiedData = await this.mergeRawgAndSteamData(
        rawgGame,
        steam_data,
        steamReviews,
        nameAnalysis,
        storeLinksForSteam, // 이미 가져온 store_links 재사용
      );

      // 8. Steam 데이터를 포함한 최종 분류
      const finalClassificationContext: ClassificationContext = {
        ...classificationContext,
        steamType: steam_data.steam_type,
        dlcList: steam_data.dlc_list,
        hasFullgameInfo: !!steam_data.fullgame_info,
      };

      const finalClassification = GameAnalysisService.classifyGame(
        finalClassificationContext,
      );

      // 🎯 DLC 역검색이 필요한 경우만 수행 (성능 최적화)
      let finalResult = finalClassification;
      if (finalClassification.reason.includes('역검색 필요')) {
        const dlcCheckResult = await GameAnalysisService.checkIfGameIsDlcInList(
          steam_data.dlc_list || [],
          rawgGame.name,
        );

        if (dlcCheckResult.isDlc) {
          finalResult = {
            gameType: 'dlc',
            confidence: 0.92,
            reason: `Steam DLC 역검색 성공: ${dlcCheckResult.reason}`,
            isMainGame: false,
            priority: 60,
            searchStrategies: finalClassification.searchStrategies,
          };
        } else {
          finalResult = {
            ...finalClassification,
            gameType: 'main_game',
            confidence: 0.88,
            reason: `Steam 본편 게임 (${steam_data.dlc_list?.length || 0}개 DLC 보유, 역검색 결과: ${dlcCheckResult.reason})`,
            isMainGame: true,
          };
        }
      }

      // 9. 최종 분석 결과 적용
      unifiedData.is_dlc = !finalResult.isMainGame;
      unifiedData.game_type = finalResult.gameType;
      unifiedData.game_type_confidence = finalResult.confidence;
      unifiedData.game_type_reason = finalResult.reason;

      // 10. DLC인 경우 부모 게임 정보 추가 (임시 필드)
      if (!finalResult.isMainGame && finalResult.gameType === 'dlc') {
        // RAWG parents 정보 추가 (detailedGame.parents가 있는 경우)
        if (detailedGame.parents && detailedGame.parents.length > 0) {
          unifiedData._rawg_parents = detailedGame.parents;
        }

        // Steam fullgame_info 추가 (steam_data.fullgame_info가 있는 경우)
        if (steam_data.fullgame_info) {
          unifiedData._steam_fullgame_info = steam_data.fullgame_info;
        }
      }

      return unifiedData;
    } catch (error) {
      // 🚨 비즈니스 로직 실패: Steam 통합 처리 전체 실패
      this.logger.error(
        `Steam 통합 처리 실패: ${rawgGame.name} - ${error?.message || error}`,
      );
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
    const nameAnalysis = GameAnalysisService.analyzeGameName(rawgGame.name);

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

    // 🎯 DataMapper로 RAWG 전용 데이터 생성 (64라인 → 1라인!)
    const baseData = DataMapper.mapRawgGameToBaseData(
      rawgGame,
      details,
      storeLinks,
      video,
    );

    // 4. 게임 분류 (RAWG 전용)
    const classificationContext: ClassificationContext = {
      rawgName: rawgGame.name,
      parentsCount: detailedGame.parents_count || 0,
      additionsCount: detailedGame.additions_count || 0,
      hasStoreLink: false, // RAWG 전용이므로 store link 없음
      nameAnalysis,
    };

    const classification = GameAnalysisService.classifyGame(
      classificationContext,
    );

    // 5. 최종 분석 결과 적용
    const finalData = {
      ...baseData,
      // === DLC 관련 (통합 분석 결과) ===
      is_dlc: !classification.isMainGame,
      game_type: classification.gameType,
      game_type_confidence: classification.confidence,
      game_type_reason: classification.reason,
    };

    // 6. DLC인 경우 부모 게임 정보 추가 (임시 필드)
    if (!classification.isMainGame && classification.gameType === 'dlc') {
      // RAWG parents 정보 추가 (detailedGame.parents가 있는 경우)
      if (detailedGame.parents && detailedGame.parents.length > 0) {
        finalData._rawg_parents = detailedGame.parents;
      }
    }

    return finalData;
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
    preloadedStoreLinks?: any, // 이미 가져온 store_links (중복 호출 방지)
  ): Promise<GameCalendarData> {
    // 기본 RAWG 데이터 생성 (재시도 로직 포함)
    const [storeLinks, details, video] = await Promise.all([
      // preloadedStoreLinks가 있으면 사용, 없으면 새로 가져오기
      preloadedStoreLinks ||
        this.getStoreLinksWithRetry(
          rawgGame.id,
          rawgGame.name,
          rawgGame.platforms,
          rawgGame.stores,
        ),
      this.getDetailsWithRetry(rawgGame.id),
      this.getYouTubeTrailer(rawgGame.name),
    ]);

    // 🎯 DataMapper로 RAWG 베이스 데이터 생성 (80라인 → 1라인!)
    const baseData = DataMapper.mapRawgGameToBaseData(
      rawgGame,
      details,
      storeLinks,
      video,
    );

    // 🔗 Steam 데이터와 병합 (40라인 → 1라인!)
    return DataMapper.mergeWithSteamData(baseData, steam_data, steamReviews);
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
   * 🔧 유틸리티: YouTube 트레일러 조회
   */
  private async getYouTubeTrailer(
    gameName: string,
  ): Promise<string | undefined> {
    try {
      const videoId = await this.youtubeService.getSimpleTrailer(gameName);
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined;
    } catch (error) {
      // 🚨 비즈니스 로직 실패: YouTube 트레일러 조회 실패
      this.logger.warn(
        `YouTube 트레일러 조회 실패: ${gameName} - ${error?.message || error}`,
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

    const existingGames = await this.gameRepository.find({
      where: { rawg_id: In(rawgIds) },
      select: ['id', 'rawg_id', 'name', 'released', 'platforms', 'steam_id'],
    });

    const gameMap = new Map<number, Game>();
    existingGames.forEach((game) => {
      gameMap.set(game.rawg_id, game);
    });

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
      // 🚨 비즈니스 로직 실패: 스토어 링크 조회 실패
      this.logger.warn(
        `스토어 링크 조회 실패: ${gameName} - ${e?.message || e}`,
      );
      return {};
    }
  }

  /**
   * 🗑️ 더미 메서드 (호환성 유지)
   * 메모리 캐시가 제거되었으므로 빈 메서드
   */
  async clearBatchCache(): Promise<void> {}

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
    return DataMapper.mapFromGameEntity(existingGame, gameDetail);
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

      // 통합 데이터 처리
      const unifiedResult = await this.processGamesForMonth(month, options);
      const results = { saved: 0, skipped: 0, errors: 0 };

      // 🎮 DLC 부모 게임들을 게임 배열에 추가 (기존 로직에 자연스럽게 통합)
      const allGames = [...unifiedResult.games];
      const addedParentIds = new Set<string>();

      // DLC를 찾아서 부모 게임들을 배열에 추가
      for (const game of unifiedResult.games) {
        if (game.is_dlc && game.game_type === 'dlc') {
          // Steam fullgame_info 우선 활용
          if (game._steam_fullgame_info?.appid) {
            try {
              const steamData = await this.steamService.getGameCalendarData(game._steam_fullgame_info.appid);
              if (steamData) {
                const parentId = `steam_${steamData.steam_id}`;
                if (!addedParentIds.has(parentId)) {
                  const parentGameData = this.createSteamParentGame(steamData);
                  allGames.push(parentGameData);
                  addedParentIds.add(parentId);
                  game._parent_steam_id = steamData.steam_id;
                  this.logger.log(`✅ Steam 부모 게임 추가: ${steamData.original_name} (DLC: ${game.name})`);
                }
              }
            } catch (error) {
              this.logger.warn(`Steam 부모 게임 생성 실패: ${error.message}`);
            }
          }
          // RAWG parents 활용
          else if (game._rawg_parents && game._rawg_parents.length > 0) {
            const parentRawgId = game._rawg_parents[0].id;
            const parentId = `rawg_${parentRawgId}`;
            if (!addedParentIds.has(parentId)) {
              const parentGameData = this.createRawgParentGame(game._rawg_parents[0]);
              allGames.push(parentGameData);
              addedParentIds.add(parentId);
              game._parent_rawg_id = parentRawgId;
              this.logger.log(`✅ RAWG 부모 게임 추가: ${game._rawg_parents[0].name} (DLC: ${game.name})`);
            }
          }
        }
      }

      // 모든 게임(부모 게임 포함)을 동일한 로직으로 저장
      for (const gameData of allGames) {
        try {
          await this.saveUnifiedGameToDatabase(gameData);
          results.saved++;
          // 🔄 통합 시스템: 로깅 제거
          // LoggerHelper.logSuccess(this.logger, '게임 저장', gameData.name);
        } catch (error) {
          if (error.code === '23505' || error.message?.includes('중복')) {
            results.skipped++;
            // 🔄 통합 시스템: 로깅 제거
            // LoggerHelper.logSkip(this.logger, gameData.name, '중복 건너뜀');
          } else {
            this.logger.warn(`saveUnifiedGamesToDatabase 게임 저장 실패: ${error.message}}`);

            results.errors++;
          }
        }
      }

     

      return results;
    } catch (error) {
      throw new Error(`통합 게임 DB 저장 실패: ${error.message}`);
    }
  }

  /**
   * 💾 개별 통합 게임 데이터 DB 저장 (증분 업데이트 지원)
   * DLC인 경우 부모 관계 자동 설정
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
        throw { code: '23505', message: '업데이트 불필요' };
      }

      return await this.updateExistingGameInDatabase(existing, gameData);
    }

    return await this.dataSource.transaction(async (manager) => {
      // Game Entity 생성 및 저장
      const game = new Game();
      Object.assign(game, DataMapper.mapToGameEntity(gameData));

      // 🎮 DLC인 경우 부모 관계 설정 (새 로직에 맞게 수정)
      if (gameData._parent_rawg_id || gameData._parent_steam_id) {
        // 부모 게임을 DB에서 찾아서 관계 설정
        let parentGame: Game | null = null;

        // Steam ID로 먼저 찾기
        if (gameData._parent_steam_id) {
          parentGame = await manager.getRepository(Game).findOne({
            where: { steam_id: gameData._parent_steam_id },
          });
        }

        // RAWG ID로 찾기 (Steam으로 못 찾은 경우)
        if (!parentGame && gameData._parent_rawg_id) {
          parentGame = await manager.getRepository(Game).findOne({
            where: { rawg_id: gameData._parent_rawg_id },
          });
        }

        if (parentGame) {
          game.parent_game_id = parentGame.id;
          game.parent_steam_game_id = parentGame.steam_id;
        }
      }

      const savedGame = await manager.save(game);

      // GameDetail Entity 생성 및 저장
      const gameDetail = new GameDetail();
      Object.assign(
        gameDetail,
        DataMapper.mapToGameDetailEntity(gameData, savedGame.id),
      );
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
      DataMapper.updateGameEntity(existingGame, newGameData);

  
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

      DataMapper.updateGameDetailEntity(gameDetail, newGameData);

      await manager.save(gameDetail);

      return updatedGame;
    });
  }

  // === 🔧 플랫폼 타입 헬퍼 함수들 ===

  /**
   * PC 호환 플랫폼 타입인지 확인
   * @param platformType 플랫폼 타입
   * @returns PC 호환 여부
   */
  private isPcCompatible(platformType: string): boolean {
    return (
      platformType === PLATFORM_TYPES.PC ||
      platformType === PLATFORM_TYPES.MIXED
    );
  }

  /**
   * 콘솔 호환 플랫폼 타입인지 확인
   * @param platformType 플랫폼 타입
   * @returns 콘솔 호환 여부
   */
  private isConsoleCompatible(platformType: string): boolean {
    return (
      platformType === PLATFORM_TYPES.CONSOLE ||
      platformType === PLATFORM_TYPES.MIXED
    );
  }

  // === 🎮 DLC 부모 게임 처리 헬퍼 메서드들 ===

  /**
   * 🔧 Steam 데이터로 부모 게임 데이터 생성 (기존 DataMapper 활용)
   */
  private createSteamParentGame(steamData: any): GameCalendarData {
    // Steam 데이터를 RAWG 형식으로 변환하여 기존 DataMapper 활용
    const virtualRawgGame = {
      id: -(steamData.steam_id), // 음수 ID로 충돌 방지
      name: steamData.original_name || steamData.korea_name || 'Unknown Game',
      released: steamData.release_date || new Date().toISOString().split('T')[0],
      tba: false,
      platforms: [{ platform: { name: 'PC', slug: 'pc' } }],
      genres: [],
      tags: [],
      background_image: steamData.image || '',
      added: 0,
      rating: 0,
      ratings_count: 0,
      developers: steamData.developers?.map((name: string) => ({ name })) || [],
      publishers: steamData.publishers?.map((name: string) => ({ name })) || [],
      stores: [],
      esrb_rating: null,
    };

    // 기존 DataMapper 활용하여 표준 형식으로 변환
    const gameData = DataMapper.mapRawgGameToBaseData(virtualRawgGame);
    gameData.steam_id = steamData.steam_id; // Steam ID 추가
    return gameData;
  }

  /**
   * 🔧 RAWG 데이터로 부모 게임 데이터 생성 (기존 로직 활용)
   */
  private createRawgParentGame(rawgParent: any): GameCalendarData {
    // RAWG parents 데이터를 기본 게임 형식으로 변환
    const parentGame = {
      id: rawgParent.id,
      name: rawgParent.name || 'Unknown Parent Game',
      released: rawgParent.released || new Date().toISOString().split('T')[0],
      tba: false,
      platforms: rawgParent.platforms || [{ platform: { name: 'PC', slug: 'pc' } }],
      genres: rawgParent.genres || [],
      tags: [],
      background_image: rawgParent.background_image || '',
      added: rawgParent.added || 0,
      rating: rawgParent.rating || 0,
      ratings_count: rawgParent.ratings_count || 0,
      developers: [],
      publishers: [],
      stores: [],
      esrb_rating: null,
    };

    // 기존 DataMapper 활용
    return DataMapper.mapRawgGameToBaseData(parentGame);
  }

}
