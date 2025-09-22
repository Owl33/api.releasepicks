import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
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
      // === 1단계: RAWG 데이터 수집 ===
      this.logger.debug(`1단계: RAWG에서 ${month} 게임 수집 중...`);
      const rawgResult = await this.rawgService.getMonthlyGames(
        month,
        Math.max(mergedOptions.max_games * 2, 50),
      );

      // === 2단계: 플랫폼별 통합 처리 ===
      this.logger.debug(`2단계: 플랫폼별 데이터 통합 중...`);
      const processedGames: GameCalendarData[] = [];
      let pcGamesCount = 0;
      let consoleGamesCount = 0;
      let steamIntegratedCount = 0;

      const finalGames = rawgResult.games.slice(0, mergedOptions.max_games);

      for (const rawgGame of finalGames) {
        try {
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

      // 1. Steam 검색용 게임명 정리
      // const cleanedName = this.cleanGameNameForSteam(rawgGame.name);
      this.logger.debug(`Steam 검색: ${rawgGame.name} → ${rawgGame.name}`);

      // 2. Steam ID 검색
      const steam_idResult = await this.steamService.findSteamId(rawgGame.name);
      if (!steam_idResult.success || !steam_idResult.steam_id) {
        this.logger.debug(`Steam ID 검색 실패: ${rawgGame.name}`);
        return await this.processRawgOnlyData(rawgGame);
      }

      // 2. Steam 게임 데이터 수집
      const steam_data = await this.steamService.getGameCalendarData(
        steam_idResult.steam_id,
        { timeout: options.steam_timeout },
      );
      if (!steam_data) {
        this.logger.debug(`Steam 데이터 조회 실패: ${rawgGame.name}`);
        return await this.processRawgOnlyData(rawgGame);
      }

      // 3. Steam 리뷰 추가
      const steamReviews = await this.steamService.getSteamReviews(
        steam_idResult.steam_id,
      );

      // 4. RAWG + Steam 데이터 통합
      const unifiedData = await this.mergeRawgAndSteamData(
        rawgGame,
        steam_data,
        steamReviews,
      );
      console.log('unifiedData', unifiedData);
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
    // RAWG 추가 정보 수집
    const [storeLinks, details, video] = await Promise.all([
      this.getStoreLinks(
        rawgGame.id,
        rawgGame.name,
        rawgGame.platforms,
        rawgGame.stores,
      ),
      this.rawgService.getDetails(rawgGame.id),
      this.getYouTubeTrailer(rawgGame.name),
    ]);

    return {
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

      /** DLC 여부 (RAWG 태그 기반 간단 판별) */
      is_dlc: this.isDLCByTags(rawgGame),

      // === 메타 정보 ===
      platform_type: this.determinePlatformType(rawgGame.platforms),
      steam_integrated: false,
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
  ): Promise<GameCalendarData> {
    // 기본 RAWG 데이터로 시작
    const baseData = await this.processRawgOnlyData(rawgGame);

    // Steam 카테고리 처리 (description만 저장)
    const steamCategories =
      steam_data.categories
        ?.map((cat: any) =>
          typeof cat === 'string' ? cat : cat.description || '',
        )
        .filter(Boolean) || [];
    // user_request.md 명세에 따른 Steam 데이터로 보강
    console.log(steamReviews);
    return {
      ...baseData,

      // === Steam 우선 데이터 ===
      required_age: steam_data.steam_id?.toString() || '',
      image: steam_data.image || baseData.image,
      screenshots:
        steam_data.screenshots.length > 0
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

      /** DLC 여부 (Steam type 우선, RAWG parent_count 백업) */
      is_dlc: steam_data.steam_type === 'dlc' || baseData.is_dlc,

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
   * 🔧 유틸리티: RAWG API를 통한 게임별 스토어 링크 조회
   * 이동됨: RawgService → UnifiedGameService
   */
  private async getStoreLinks(
    gameId: number,
    gameName: string,
    platforms: any,
    stores: any,
  ): Promise<StoreLinks> {
    const STORE_KEYS = [
      'steam',
      'gog',
      'epic',
      'playstation',
      'xbox',
      'nintendo',
    ] as const;

    // RAWG store_id → StoreLinks 키 매핑
    const STORE_ID_MAP: Record<number, keyof StoreLinks> = {
      1: 'steam',
      5: 'gog',
      11: 'epic',
      // 필요 시 콘솔 스토어도 추가 가능
      // 2: "playstation",
      // 3: "xbox",
      // 4: "nintendo"
    };
    const links: StoreLinks = {};
    const encodedName = encodeURIComponent(gameName);
    const slugs: string[] = (platforms ?? []).map((p: any) =>
      typeof p === 'string' ? p.toLowerCase() : p.platform.slug.toLowerCase(),
    );

    try {
      // 1) RAWG 결과로 먼저 채우기
      const res = await this.rawgService.getStore(gameId);
      res?.results?.forEach((r: any) => {
        const key = STORE_ID_MAP[r.store_id];
        if (key && !links[key] && r.url) links[key] = r.url;
      });
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
   * 🔧 유틸리티: DLC 판별 (보수적 접근)
   * parent_count만으로는 부정확하므로 여러 조건 조합으로 판별
   */
  private isDLCByTags(rawgGame: any): boolean {
    const gameName = (rawgGame.name || '').toLowerCase();
    const tags = (rawgGame.tags || [])
      .map((t: any) => t.name?.toLowerCase())
      .filter(Boolean);

    // 1. 확실한 DLC 태그 체크 (가장 신뢰할 만함)
    const dlcTags = ['dlc', 'expansion', 'add-on', 'downloadable content'];
    if (dlcTags.some((tag) => tags.includes(tag))) {
      this.logger.debug(`DLC 판별: ${rawgGame.name} (DLC 태그 발견)`);
      return true;
    }

    // 2. 게임명에 DLC 패턴 포함 (콜론 + 부제목)
    if (!gameName.includes('remastered') && !gameName.includes('edition')) {
      // 추가 검증: 짧은 부제목은 DLC일 가능성 높음
      const subtitle = gameName.split(': ')[1];
      if (subtitle && subtitle.length < 30) {
        this.logger.debug(`DLC 판별: ${rawgGame.name} (부제목 패턴)`);
        return true;
      }
    }

    // 3. parent_count + 게임명 조합으로 보수적 판별
    if (rawgGame.parent_count && rawgGame.parent_count > 0) {
      // DLC 키워드가 있으면서 parent_count가 있는 경우만
      const dlcKeywords = ['dlc', 'expansion', 'pack', 'content'];
      if (dlcKeywords.some((keyword) => gameName.includes(keyword))) {
        this.logger.debug(
          `DLC 판별: ${rawgGame.name} (parent_count + DLC 키워드)`,
        );
        return true;
      }
    }

    // 4. additions_count는 본편 게임의 강한 지표 (DLC가 아님)
    if (rawgGame.additions_count && rawgGame.additions_count > 0) {
      this.logger.debug(
        `본편 게임: ${rawgGame.name} (additions_count: ${rawgGame.additions_count})`,
      );
      return false;
    }

    return false;
  }

  /**
   * 🔧 유틸리티: Steam 검색용 게임명 정리
   * DLC명, PC Port 등을 제거하여 핵심 게임명만 추출
   */
  private cleanGameNameForSteam(gameName: string): string {
    if (!gameName) return '';

    let cleaned = gameName.trim();

    // 1. DLC명 정리: ": " 뒤의 부분 제거 (예: "Atomic Heart: Annihilation Instinct" → "Atomic Heart")
    if (cleaned.includes(': ')) {
      const colonIndex = cleaned.indexOf(': ');
      const beforeColon = cleaned.substring(0, colonIndex).trim();
      // 앞부분이 의미있는 길이면 사용
      if (beforeColon.length >= 3) {
        cleaned = beforeColon;
      }
    }

    // 2. 플랫폼 관련 용어 제거
    const platformTerms = [
      'PC Port',
      'PC Version',
      'Steam Edition',
      "Director's Cut",
      'GOTY Edition',
      'Game of the Year',
      'Complete Edition',
      'Ultimate Edition',
      'Deluxe Edition',
      'Definitive Edition',
    ];

    for (const term of platformTerms) {
      const regex = new RegExp(`\\b${term}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '').trim();
    }

    // 3. 연속된 공백 정리
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // 4. 빈 문자열이면 원본 반환
    if (!cleaned || cleaned.length < 3) {
      return gameName.trim();
    }

    return cleaned;
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
   * 💾 개별 통합 게임 데이터 DB 저장
   */
  private async saveUnifiedGameToDatabase(
    gameData: GameCalendarData,
  ): Promise<Game> {
    // 중복 체크
    const existing = await this.gameRepository.findOne({
      where: { rawg_id: gameData.rawg_id },
    });
    if (existing) {
      throw { code: '23505', message: '중복 게임' };
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
}
