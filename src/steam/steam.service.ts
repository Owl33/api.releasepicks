import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
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

  // Steam 공식 Web API 엔드포인트
  private readonly STEAM_APPLIST_URL =
    'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
  private readonly STEAM_APPDETAILS_URL =
    'https://store.steampowered.com/api/appdetails';

  // 기본 설정
  private readonly DEFAULT_OPTIONS: SteamApiOptions = {
    language: 'korean',
    country_code: 'KR',
    timeout: 10000,
  };

  // Steam 전체 앱 목록 캐시 (메모리 절약)
  private steamAppListCache: { appid: number; name: string }[] | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1시간

  /**
   * 1. Steam 공식 API로 게임명 기반 Steam ID 검색
   * GetAppList API + 클라이언트 측 필터링 사용
   */
  async findSteamId(gameName: string): Promise<SteamIdSearchResult> {
    try {
      this.logger.debug(`Steam ID 검색 시작 (공식 API): ${gameName}`);

      // Steam 앱 목록 가져오기 (캐시 활용)
      const appList = await this.getSteamAppList();
      if (!appList || appList.length === 0) {
        this.logger.debug(`Steam 앱 목록 없음`);
        return {
          success: false,
          original_query: gameName,
        };
      }

      // 게임명 기반 필터링 및 매칭
      const filteredApps = this.filterAppsByName(gameName, appList);
      if (filteredApps.length === 0) {
        this.logger.debug(`매칭되는 게임 없음: ${gameName}`);
        return {
          success: false,
          original_query: gameName,
        };
      }

      // 최적 매칭 찾기
      const bestMatch = this.findBestAppMatch(gameName, filteredApps);
      if (bestMatch) {
        this.logger.debug(
          `Steam ID 발견: ${bestMatch.appid} (${bestMatch.name}) - 유사도: ${bestMatch.matchScore?.toFixed(2)}`,
        );
        return {
          success: true,
          steam_id: bestMatch.appid,
          match_score: bestMatch.matchScore,
          original_query: gameName,
          found_name: bestMatch.name,
        };
      }

      this.logger.debug(`적절한 매칭 없음: ${gameName}`);
      return {
        success: false,
        original_query: gameName,
      };
    } catch (error) {
      this.logger.warn(`Steam ID 검색 실패: ${gameName}`, error.message);
      return {
        success: false,
        original_query: gameName,
      };
    }
  }

  /**
   * 2. 게임 캘린더용 전체 정보 수집
   * appDetails 한 번 호출로 모든 정보 처리 (기본정보+리뷰 통합)
   */
  async getGameCalendarData(
    steamId: number,
    options?: SteamApiOptions,
  ): Promise<GameCalendarSteamData | null> {
    try {
      this.logger.debug(`Steam 게임 데이터 수집 시작: ${steamId}`);

      const mergedOptions = { ...this.DEFAULT_OPTIONS, ...options };

      // Steam appDetails API 호출
      const appDetails = await this.getAppDetails(steamId, mergedOptions);
      if (!appDetails) {
        this.logger.warn(`Steam appDetails 조회 실패: ${steamId}`);
        return null;
      }

      // 게임 캘린더용 데이터 변환
      const calendarData = this.convertToCalendarData(appDetails);

      this.logger.debug(
        `Steam 게임 데이터 수집 완료: ${steamId} (${appDetails.name})`,
      );
      return calendarData;
    } catch (error) {
      this.logger.error(
        `Steam 게임 데이터 수집 실패: ${steamId}`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Steam appDetails API 호출
   */
  private async getAppDetails(
    steamId: number,
    options: SteamApiOptions,
  ): Promise<SteamAppData | null> {
    try {
      const params = new URLSearchParams({
        appids: steamId.toString(),
        l: options.language || 'korean',
        cc: options.country_code || 'KR',
      });

      const response = await axios.get<SteamAppDetailsResponse>(
        `${this.STEAM_APPDETAILS_URL}?${params.toString()}`,
        {
          timeout: options.timeout,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
      );

      const appData = response.data[steamId.toString()];

      if (!appData || !appData.success || !appData.data) {
        this.logger.warn(
          `Steam appDetails 응답 실패 또는 데이터 없음: ${steamId}`,
        );
        return null;
      }

      return appData.data;
    } catch (error) {
      this.logger.error(
        `Steam appDetails API 호출 실패: ${steamId}`,
        error.message,
      );
      throw error;
    }
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
      categories: appData.categories?.map((c) => c.description) || [],
      image: appData.header_image,
      // DLC 관련 정보 (Steam 공식 type 필드 활용)
      is_full_game: appData.type === 'game',
      fullgame_info: appData.fullgame, // DLC인 경우 본편 게임 정보
      dlc_list: appData.dlc || [], // 본편인 경우 DLC 목록

      // 추가 정보
      screenshots: appData.screenshots?.map((s) => s.path_full) || [],
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
    try {
      this.logger.debug(`Steam 리뷰 조회 시작: ${steam_id}`);

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
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
      );

      const data = response.data;
      
      // API 호출 실패 체크
      if (data.success !== 1 || !data.query_summary) {
        this.logger.warn(
          `Steam 리뷰 API 실패: ${steam_id} (success: ${data.success})`,
        );
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

      this.logger.debug(
        `Steam 리뷰 조회 성공: ${steam_id} - ${summary.review_score_desc} (${summary.total_reviews}개 리뷰, 긍정 ${positivePercentage}%)`,
      );

      return reviewSummary;
    } catch (error) {
      this.logger.warn(`Steam 리뷰 조회 실패: ${steam_id}`, error.message);
      return this.createEmptyReviewSummary();
    }
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
    try {
      // 캐시 확인
      const now = Date.now();
      if (
        this.steamAppListCache &&
        now - this.cacheTimestamp < this.CACHE_DURATION
      ) {
        this.logger.debug('Steam 앱 목록 캐시 사용');
        return this.steamAppListCache;
      }

      this.logger.debug('Steam 공식 GetAppList API 호출');
      const response = await axios.get(this.STEAM_APPLIST_URL, {
        timeout: this.DEFAULT_OPTIONS.timeout,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const appList = response.data?.applist?.apps || [];

      // 캐시 업데이트
      this.steamAppListCache = appList;
      this.cacheTimestamp = now;

      this.logger.debug(`Steam 앱 목록 캐시 업데이트: ${appList.length}개`);
      return appList;
    } catch (error) {
      this.logger.warn('Steam GetAppList API 호출 실패', error.message);
      return this.steamAppListCache || [];
    }
  }

  /**
   * 게임명 기반 Steam 앱 필터링
   */
  private filterAppsByName(
    gameName: string,
    appList: { appid: number; name: string }[],
  ): { appid: number; name: string }[] {
    const searchTerm = gameName.toLowerCase().trim();

    return appList.filter((app) => {
      if (!app.name) return false;

      const appName = app.name.toLowerCase();
      // 정확한 매칭 우선
      if (appName === searchTerm) return true;

      // 부분 매칭 (단어 포함)
      const searchWords = searchTerm
        .split(' ')
        .filter((word) => word.length > 2);
      if (searchWords.length === 0) return appName.includes(searchTerm);

      return searchWords.every((word) => appName.includes(word));
    });
  }

  /**
   * 최적 매칭 찾기 (유사도 점수 기반)
   */
  private findBestAppMatch(
    gameName: string,
    apps: { appid: number; name: string }[],
  ): any {
    if (apps.length === 0) return null;

    const searchTerm = gameName.toLowerCase().trim();
    let bestMatch: any = null;
    let bestScore = 0;

    for (const app of apps) {
      const appName = app.name.toLowerCase();
      let score = 0;

      // 정확한 매칭
      if (appName === searchTerm) {
        score = 1.0;
      }
      // 시작 매칭
      else if (appName.startsWith(searchTerm)) {
        score = 0.9;
      }
      // 포함 매칭
      else if (appName.includes(searchTerm)) {
        score = 0.7;
      }
      // 단어 매칭
      else {
        const searchWords = searchTerm.split(' ');
        const matchedWords = searchWords.filter((word) =>
          appName.includes(word),
        );
        if (matchedWords.length > 0) {
          score = (matchedWords.length / searchWords.length) * 0.5;
        }
      }

      // 더 짧은 이름 선호 (동일 점수일 때)
      if (
        score > bestScore ||
        (score === bestScore &&
          (!bestMatch || app.name.length < bestMatch.name.length))
      ) {
        bestScore = score;
        bestMatch = {
          appid: app.appid,
          name: app.name,
          matchScore: score,
        };
      }
    }

    // 최소 점수 임계값 (0.3 이상만 인정)
    return bestScore >= 0.3 ? bestMatch : null;
  }

  /**
   * 🔍 Steam DLC 역검색: DLC 목록에서 특정 게임명과 일치하는지 확인
   * @param dlcIds DLC Steam ID 배열
   * @param originalGameName 원본 게임명 (RAWG)
   * @returns DLC 일치 결과
   */
  async checkIfGameIsDlcInList(
    dlcIds: number[],
    originalGameName: string,
  ): Promise<{
    isDlc: boolean;
    matchedDlc?: {
      steam_id: number;
      name: string;
      similarity: number;
    };
    reason: string;
  }> {
    try {
      this.logger.debug(`DLC 역검색 시작: ${originalGameName} in [${dlcIds.join(', ')}]`);

      // DLC 목록이 없거나 너무 많으면 건너뛰기
      if (!dlcIds || dlcIds.length === 0) {
        return {
          isDlc: false,
          reason: 'DLC 목록 없음'
        };
      }

      if (dlcIds.length > 20) {
        this.logger.warn(`DLC 목록이 너무 많음 (${dlcIds.length}개), 건너뛰기`);
        return {
          isDlc: false,
          reason: `DLC 목록이 너무 많음 (${dlcIds.length}개)`
        };
      }

      // 각 DLC의 이름을 조회하여 비교
      for (const dlcId of dlcIds) {
        try {
          const dlcName = await this.getDlcName(dlcId);
          if (!dlcName) continue;

          const similarity = this.calculateNameSimilarity(originalGameName, dlcName);

          this.logger.debug(`DLC 비교: "${originalGameName}" vs "${dlcName}" = ${similarity.toFixed(2)}`);

          // 유사도 80% 이상이면 일치로 판단
          if (similarity >= 0.8) {
            return {
              isDlc: true,
              matchedDlc: {
                steam_id: dlcId,
                name: dlcName,
                similarity
              },
              reason: `DLC 목록에서 발견: "${dlcName}" (유사도: ${(similarity * 100).toFixed(1)}%)`
            };
          }
        } catch (error) {
          this.logger.warn(`DLC ${dlcId} 조회 실패:`, error.message);
          continue;
        }
      }

      return {
        isDlc: false,
        reason: `DLC 목록 ${dlcIds.length}개 중 일치하는 게임 없음`
      };
    } catch (error) {
      this.logger.error(`DLC 역검색 실패: ${originalGameName}`, error.message);
      return {
        isDlc: false,
        reason: `DLC 역검색 오류: ${error.message}`
      };
    }
  }

  /**
   * 🔍 특정 Steam ID의 게임명만 조회 (경량화)
   */
  private async getDlcName(steamId: number): Promise<string | null> {
    try {
      const response = await axios.get<SteamAppDetailsResponse>(
        `${this.STEAM_APPDETAILS_URL}?appids=${steamId}&l=korean&cc=KR`,
        {
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
      );

      const appData = response.data[steamId.toString()];

      if (!appData || !appData.success || !appData.data) {
        return null;
      }

      return appData.data.name || null;
    } catch (error) {
      this.logger.warn(`Steam ${steamId} 이름 조회 실패:`, error.message);
      return null;
    }
  }

  /**
   * 🔍 게임명 유사도 계산 (Jaro-Winkler 유사 알고리즘)
   */
  private calculateNameSimilarity(name1: string, name2: string): number {
    if (!name1 || !name2) return 0;

    const clean1 = name1.toLowerCase().trim();
    const clean2 = name2.toLowerCase().trim();

    // 정확히 일치
    if (clean1 === clean2) return 1.0;

    // 한쪽이 다른 쪽을 포함 (DLC 패턴)
    if (clean1.includes(clean2) || clean2.includes(clean1)) {
      const shorter = clean1.length < clean2.length ? clean1 : clean2;
      const longer = clean1.length >= clean2.length ? clean1 : clean2;
      return shorter.length / longer.length;
    }

    // 단어 기반 유사도 (간단한 Jaccard 유사도)
    const words1 = new Set(clean1.split(/\s+/));
    const words2 = new Set(clean2.split(/\s+/));

    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  /**
   * Steam 서비스 상태 체크 (헬스체크용)
   */
  async checkSteamApiHealth(): Promise<{ status: string; timestamp: Date }> {
    try {
      // 간단한 검색으로 Steam API 상태 확인
      const testResult = await this.findSteamId('Counter-Strike');

      return {
        status: testResult.success ? 'healthy' : 'degraded',
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date(),
      };
    }
  }
}
