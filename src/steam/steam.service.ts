import { Injectable, Logger } from '@nestjs/common';
import slugify from 'slugify';

import axios from 'axios';
import { STEAM_API, LoggerHelper } from '../utils/game-utilities';
import { ErrorHandlerUtil } from '../common/utils/error-handler.util';
import { DataMapper } from '../utils/data-processing';
import {
  SteamAppDetailsResponse,
  GameCalendarSteamData,
  SteamIdSearchResult,
  SteamApiOptions,
  SteamAppData,
  SteamSearchResult,
  SteamReviewsApiResponse,
  SteamReviewSummary,
  SteamReviewApiOptions,
} from '../types/steam.types';

/**
 * 간소화된 Steam API 서비스
 * 게임 캘린더 특화: Steam ID 검색 + appDetails 통합 처리
 */
@Injectable()
export class StreamlinedSteamService {
  private readonly logger = new Logger(StreamlinedSteamService.name);

  // 기본 설정
  private readonly DEFAULT_OPTIONS: SteamApiOptions = {
    language: 'korean',
    country_code: 'KR',
    timeout: STEAM_API.DEFAULT_TIMEOUT,
  };

  // Steam 전체 앱 목록 캐시 (메모리 절약)
  private steamAppListCache: { appid: number; name: string }[] | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1시간

  /**
   * 1. Steam 공식 API로 게임명 기반 Steam ID 검색
   * GetAppList API + 클라이언트 측 필터링 사용
   *
   * @param gameName 검색할 게임명
   * @param storeLinks RAWG에서 제공하는 스토어 링크 (store_links 우선 확인용)
   * @param searchStrategies 추가 검색 전략들 (게임 분류 시스템에서 제공)
   */
  async findSteamId(
    gameName: string,
    storeLinks?: { steam?: string },
    searchStrategies?: string[]
  ): Promise<SteamIdSearchResult> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
      // 🥇 RAWG store_links 우선 확인: Steam 스토어 링크가 있으면 App ID 직접 추출
      if (storeLinks?.steam) {
        const extractedAppId = this.extractSteamAppIdFromUrl(storeLinks.steam);
        if (extractedAppId) {
          return {
            success: true,
            steam_id: extractedAppId,
            match_score: 1.0, // store_links는 100% 신뢰도
            original_query: gameName,
            found_name: `Steam App ${extractedAppId} (from store_links)`,
          };
        }
        // store_links 실패는 정상적인 fallback이므로 로그 불필요
      }

      // Steam 앱 목록 가져오기 (캐시 활용)
      const appList = await this.getSteamAppList();
      if (!appList || appList.length === 0) {
        return {
          success: false,
          original_query: gameName,
        };
      }
      this.buildSteamSlugMap(appList);

      // 🎯 다중 검색 전략 시도
      const searchNames = this.buildSearchNames(gameName, searchStrategies);

      for (const [index, searchName] of searchNames.entries()) {

        const filteredApps = this.filterAppsByName(searchName, appList);
        if (filteredApps.length === 0) {
          continue;
        }

        // 🎯 최적화된 매칭 찾기 (간소화된 로직)
        const bestMatch = this.findBestAppMatchOptimized(searchName, filteredApps);
        if (bestMatch) {
          return {
            success: true,
            steam_id: bestMatch.appid,
            match_score: bestMatch.matchScore,
            original_query: gameName,
            found_name: bestMatch.name,
            search_strategy: `strategy_${index + 1}_${searchName}`,
          };
        }
      }

      return {
        success: false,
        original_query: gameName,
      };
      },
      this.logger,
      {
        context: 'Steam ID 검색',
        identifier: gameName,
        rethrow: false,
        defaultMessage: 'Steam ID 검색 실패',
      }
    ).then(result => result || {
      success: false,
      original_query: gameName,
    });
  }

  /**
   * 2. 게임 캘린더용 전체 정보 수집
   * appDetails 한 번 호출로 모든 정보 처리 (기본정보+리뷰 통합)
   */
  async getGameCalendarData(
    steamId: number,
    options?: SteamApiOptions,
  ): Promise<GameCalendarSteamData | null> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        const mergedOptions = { ...this.DEFAULT_OPTIONS, ...options };

        // Steam appDetails API 호출
        const appDetails = await this.getAppDetails(steamId, mergedOptions);
        if (!appDetails) {
          this.logger.error(`Steam appDetails 조회 실패: ${steamId} - 데이터 없음`);
          return null;
        }

        // 게임 캘린더용 데이터 변환
        try {
          const calendarData = this.convertToCalendarData(appDetails);
          return calendarData;
        } catch (conversionError) {
          this.logger.error(`Steam 데이터 변환 실패: ${steamId} - ${conversionError.message}`);
          return null;
        }
      },
      this.logger,
      {
        context: 'Steam 게임 데이터 수집',
        identifier: steamId.toString(),
        rethrow: false,
        defaultMessage: 'Steam 게임 데이터 수집 실패',
      }
    ).then(result => result || null);
  }

  /**
   * Steam appDetails API 호출
   */
  private async getAppDetails(
    steamId: number,
    options: SteamApiOptions,
  ): Promise<SteamAppData | null> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        const params = new URLSearchParams({
          appids: steamId.toString(),
          l: options.language || 'korean',
          cc: options.country_code || 'KR',
        });

        const response = await axios.get<SteamAppDetailsResponse>(
          `${STEAM_API.APPDETAILS_URL}?${params.toString()}`,
          {
            timeout: options.timeout,
            headers: {
              'User-Agent': STEAM_API.USER_AGENT,
            },
          },
        );

        const appData = response.data[steamId.toString()];

        if (!appData || !appData.success || !appData.data) {
          this.logger.error(`Steam appDetails 응답 실패: ${steamId} - 유효하지 않은 데이터`);
          return null;
        }

        return appData.data;
      },
      this.logger,
      {
        context: 'Steam appDetails API',
        identifier: steamId.toString(),
        rethrow: true,
        defaultMessage: 'Steam appDetails API 호출 실패',
      }
    );
  }

  /**
   * Steam appData를 게임 캘린더용 데이터로 변환
   */
  private convertToCalendarData(appData: SteamAppData): GameCalendarSteamData {
    return {
      steam_id: appData.steam_appid,
      original_name: appData.name,
      korea_name: this.extractKoreanName(appData.name),
      price: this.formatPrice(appData.price_overview, appData.is_free),
      steam_type: appData.type, // Steam 공식 타입: "game", "dlc", "music", "demo"
      description: appData.short_description,
      korean_description: appData.detailed_description,
      developers: appData.developers || [],
      publishers: appData.publishers || [],
      release_date: appData.release_date?.date,
      categories: DataMapper.normalizeSteamCategories(appData.categories || []),
      image: appData.header_image,
      // DLC 관련 정보 (Steam 공식 type 필드 활용)
      is_full_game: appData.type === 'game',
      fullgame_info: appData.fullgame, // DLC인 경우 본편 게임 정보
      dlc_list: appData.dlc || [], // 본편인 경우 DLC 목록

      // 추가 정보
      screenshots: DataMapper.normalizeScreenshots(appData.screenshots?.map((s) => s.path_full)),
      website: appData.website,
      is_free: appData.is_free,
    };
  }

  /**
   * 한글명 추출 (게임명에서 한글 부분만 추출)
   */
  private extractKoreanName(name: string): string | undefined {
    if (!name) return undefined;

    // 한글 패턴 매칭
    const koreanMatch = name.match(/[가-힣\s]+/g);
    if (koreanMatch) {
      const korean = koreanMatch.join(' ').trim();
      if (korean.length > 1) {
        // 최소 2글자 이상
        return korean;
      }
    }

    return undefined;
  }

  /**
   * 가격 정보 포맷팅
   */
  private formatPrice(priceOverview: any, isFree: boolean): string {
    if (isFree) {
      return 'Free';
    }

    if (priceOverview && priceOverview.final_formatted) {
      return priceOverview.final_formatted;
    }

    return 'N/A';
  }

  // ===== 🆕 Steam 리뷰 API 메서드들 =====

  /**
   * Steam 리뷰 데이터 조회
   * user_request.md 명세: GET store.steampowered.com/appreviews/<appid>?json=1
   */
  async getSteamReviews(
    steam_id: number,
    options: SteamReviewApiOptions = {},
  ): Promise<SteamReviewSummary> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {

      const defaultOptions: Required<SteamReviewApiOptions> = {
        language: 'all',
        review_type: 'all',
        purchase_type: 'all',
        num_per_page: 0, // 요약 정보만 필요
        cursor: '*',
        ...options,
      };

      // Steam 리뷰 API 호출
      const response = await axios.get<SteamReviewsApiResponse>(
        `http://store.steampowered.com/appreviews/${steam_id}/`,
        {
          params: {
            json: 1,
            language: defaultOptions.language,
            review_type: defaultOptions.review_type,
            purchase_type: defaultOptions.purchase_type,
            num_per_page: defaultOptions.num_per_page,
            cursor: defaultOptions.cursor,
          },
          timeout: this.DEFAULT_OPTIONS.timeout,
          headers: {
            'User-Agent': STEAM_API.USER_AGENT,
          },
        },
      );

      const data = response.data;
      // API 호출 실패 체크
      if (data.success !== 1 || !data.query_summary) {
        this.logger.error(`Steam 리뷰 API 실패: ${steam_id} - success: ${data.success}`);
        return this.createEmptyReviewSummary();
      }

      const summary = data.query_summary;

      // 긍정적 리뷰 비율 계산
      const positivePercentage =
        summary.total_reviews > 0
          ? Math.round((summary.total_positive / summary.total_reviews) * 100)
          : 0;

      const reviewSummary: SteamReviewSummary = {
        success: true,
        num_reviews: summary.num_reviews,
        review_score: summary.review_score,
        review_score_desc: summary.review_score_desc,
        total_positive: summary.total_positive,
        total_negative: summary.total_negative,
        total_reviews: summary.total_reviews,
      };

      return reviewSummary;
      },
      this.logger,
      {
        context: 'Steam 리뷰 조회',
        identifier: steam_id.toString(),
        rethrow: false,
        defaultMessage: 'Steam 리뷰 조회 실패',
      }
    ).then(result => result || this.createEmptyReviewSummary());
  }

  /**
   * 빈 리뷰 요약 객체 생성 (실패 시 사용)
   */
  private createEmptyReviewSummary(): SteamReviewSummary {
    return {
      success: false,
      num_reviews: 0,
      review_score: 0,
      review_score_desc: '리뷰 없음',
      total_positive: 0,
      total_negative: 0,
      total_reviews: 0,
    };
  }

  /**
   * Steam 공식 GetAppList API 호출 (캐시 활용)
   */
  private async getSteamAppList(): Promise<{ appid: number; name: string }[]> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        // 캐시 확인
        const now = Date.now();
        if (
          this.steamAppListCache &&
          now - this.cacheTimestamp < this.CACHE_DURATION
        ) {
          return this.steamAppListCache;
        }

        const response = await axios.get(STEAM_API.APPLIST_URL, {
          timeout: this.DEFAULT_OPTIONS.timeout,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });

        const appList = response.data?.applist?.apps || [];

        if (appList.length === 0) {
          this.logger.error('Steam GetAppList API 응답 비어있음');
        }

        // 캐시 업데이트
        this.steamAppListCache = appList;
        this.cacheTimestamp = now;

        return appList;
      },
      this.logger,
      {
        context: 'Steam GetAppList API',
        identifier: 'appList',
        rethrow: false,
        defaultMessage: 'Steam GetAppList API 호출 실패',
      }
    ).then(result => result || this.steamAppListCache || []);
  }
  private canonicalSlug(name: string) {
    if (!name) return '';
    return slugify(name, { lower: true, remove: /[*+~.()"'!:@,]/g })
      .replace(/[-_]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // 2) map 빌드 (한 번만 호출)
  private steamSlugMap: Map<
    string,
    { appid: number; name: string; slug: string }[]
  > | null = null;

  private buildSteamSlugMap(appList: { appid: number; name: string }[]) {
    const map = new Map<
      string,
      { appid: number; name: string; slug: string }[]
    >();
    for (const app of appList) {
      const baseSlug = this.canonicalSlug(app.name);
      const entry = { appid: app.appid, name: app.name, slug: baseSlug };
      const push = (s: string) => {
        if (!s) return;
        const arr = map.get(s);
        if (!arr) map.set(s, [entry]);
        else arr.push(entry);
      };
      push(baseSlug);
      // 흔한 변형들(옵션): 콜론 제거, 괄호 제거, 아포스트로피 제거
      push(this.canonicalSlug(app.name.replace(/:.+$/, '')));
      push(this.canonicalSlug(app.name.replace(/\(.*?\)/g, '')));
      push(this.canonicalSlug(app.name.replace(/'/g, '')));
    }
    this.steamSlugMap = map;
  }
  /**
   * 게임명 기반 Steam 앱 필터링
   */
  private filterAppsByName(
    gameName: string,
    appList: { appid: number; name: string }[],
  ) {
    if (!gameName) return [];

    const searchSlug = this.canonicalSlug(gameName);
    if (this.steamSlugMap) {
      const slugHits = this.steamSlugMap.get(searchSlug);
      if (slugHits && slugHits.length) return slugHits;
    }

    // 보조: 원래 exact name 비교 유지 (대소문자 무시)
    const lower = gameName.toLowerCase().trim();
    const exactHits = appList.filter(
      (a) => a.name && a.name.toLowerCase().trim() === lower,
    );
    if (exactHits.length)
      return exactHits.map((a) => ({
        appid: a.appid,
        name: a.name,
        slug: this.canonicalSlug(a.name),
      }));

    return []; // 의도적으로 퍼지/부분매칭 없음
  }

  /**
   * 🎯 최적화된 매칭 찾기 (slug 기반 매칭용)
   * buildSteamSlugMap 도입으로 인한 간소화된 로직
   */
  private findBestAppMatchOptimized(
    gameName: string,
    apps: { appid: number; name: string; slug?: string }[],
  ): any {
    if (apps.length === 0) return null;

    // 1개만 매칭되면 바로 반환 (slug 매칭은 이미 정확함)
    if (apps.length === 1) {
      return {
        appid: apps[0].appid,
        name: apps[0].name,
        matchScore: 1.0, // slug 매칭 성공 = 100% 신뢰도
      };
    }

    // 여러 개 매칭 시 간단한 선택 로직
    const searchTerm = gameName.toLowerCase().trim();
    let bestMatch = apps[0];
    let bestScore = 0;

    for (const app of apps) {
      const appName = app.name.toLowerCase();
      let score = 0.8; // 기본 점수 (slug 매칭 성공)

      // 정확한 이름 매칭이면 가산점
      if (appName === searchTerm) {
        score = 1.0;
      }
      // 더 짧은 이름 선호 (DLC보다 본편 우선)
      else if (app.name.length < bestMatch.name.length) {
        score += 0.1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = app;
      }
    }

    return {
      appid: bestMatch.appid,
      name: bestMatch.name,
      matchScore: bestScore,
    };
  }


  /**
   * 🎯 검색 이름들 구성 (간소화)
   * GameAnalysisService에서 제공하는 검색 전략들을 우선 사용
   */
  private buildSearchNames(gameName: string, searchStrategies?: string[]): string[] {
    const searchNames: string[] = [];

    // 1. GameAnalysisService에서 제공하는 전략들 우선 사용
    if (searchStrategies && searchStrategies.length > 0) {
      searchNames.push(...searchStrategies);
    }

    // 2. 기본 게임명 (전략에 없는 경우만)
    if (!searchNames.includes(gameName)) {
      searchNames.push(gameName);
    }

    // 중복 제거 및 유효성 검사
    return [...new Set(searchNames)].filter(name => name && name.length >= 3);
  }

  /**
   * 🔗 Steam 스토어 URL에서 App ID 추출
   * URL 형태: https://store.steampowered.com/app/123456/game_name/
   */
  private extractSteamAppIdFromUrl(steamUrl: string): number | null {
    try {
      // Steam 스토어 URL 패턴 매칭
      const steamUrlPattern = /store\.steampowered\.com\/app\/(\d+)/i;
      const match = steamUrl.match(steamUrlPattern);

      if (match && match[1]) {
        const appId = parseInt(match[1], 10);
        return isNaN(appId) ? null : appId;
      }

      return null;
    } catch (error) {
      // LoggerHelper.logWarn(this.logger, 'Steam URL App ID 추출 실패', error.message, steamUrl);
      return null;
    }
  }

  /**
   * Steam 서비스 상태 체크 (헬스체크용)
   */
  async checkSteamApiHealth(): Promise<{ status: string; timestamp: Date }> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        // 간단한 검색으로 Steam API 상태 확인
        const testResult = await this.findSteamId('Counter-Strike');

        if (!testResult.success) {
          this.logger.error('Steam API 상태 체크 실패: degraded 상태');
        }

        return {
          status: testResult.success ? 'healthy' : 'degraded',
          timestamp: new Date(),
        };
      },
      this.logger,
      {
        context: 'Steam API 헬스체크',
        identifier: 'health-check',
        rethrow: false,
        defaultMessage: 'Steam API 상태 체크 실패',
      }
    ).then(result => result || { status: 'unhealthy', timestamp: new Date() });
  }
}
