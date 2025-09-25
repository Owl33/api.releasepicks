/**
 * 🎯 게임 관련 유틸리티 통합
 * constants + steam-api-client + logger-helper 통합
 *
 * 통합된 기능:
 * - 게임 분석 관련 상수 정의
 * - Steam API 클라이언트
 * - 로깅 헬퍼 패턴
 */

import axios from 'axios';
import { Logger } from '@nestjs/common';

// === 상수 정의 ===

export const STEAM_API = {
  APPDETAILS_URL: 'https://store.steampowered.com/api/appdetails',
  APPLIST_URL: 'https://api.steampowered.com/ISteamApps/GetAppList/v2/',
  DEFAULT_TIMEOUT: 10000,
  DLC_TIMEOUT: 5000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
} as const;

export const RAWG_API = {
  DEFAULT_TIMEOUT: 10000,
  DETAILS_TIMEOUT: 15000,
  STORES_TIMEOUT: 5000,
} as const;

export const GAME_KEYWORDS = {
  DLC: [
    'dlc', 'expansion', 'season pass', 'episode', 'pack',
    'content pack', 'add-on', 'downloadable content'
  ],
  EDITION: [
    'remaster', 'remastered', 'definitive edition', 'complete edition',
    'director\'s cut', 'anniversary edition', 'ultimate edition',
    'deluxe edition', 'goty', 'game of the year', 'enhanced edition',
    'gold edition', 'premium edition', 'special edition', 'collector\'s edition',
    'legendary edition', 'royal edition', 'platinum edition'
  ],
  PORT: [
    'pc port', 'pc version', 'steam edition', 'console edition'
  ]
} as const;

export const PLATFORM_TYPES = {
  PC: 'pc',
  CONSOLE: 'console',
  MIXED: 'mixed'
} as const;

export type PlatformType = typeof PLATFORM_TYPES[keyof typeof PLATFORM_TYPES];

export const GAME_TYPES = {
  MAIN_GAME: 'main_game',
  DLC: 'dlc',
  EDITION: 'edition',
  PORT: 'port',
  STANDALONE: 'standalone'
} as const;

export type GameType = typeof GAME_TYPES[keyof typeof GAME_TYPES];

export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.9,
  MEDIUM: 0.7,
  LOW: 0.5,
  SIMILARITY: 0.8
} as const;

export const PERFORMANCE_LIMITS = {
  MAX_DLC_LIST_SIZE: 20,
  MAX_SEARCH_STRATEGIES: 5,
  CACHE_DURATION: 60 * 60 * 1000,
} as const;

// === Steam API 응답 타입 ===

interface SteamAppDetailsResponse {
  [app_id: string]: {
    success: boolean;
    data?: {
      name: string;
      steam_appid: number;
    };
  };
}

interface SteamAppListResponse {
  applist: {
    apps: Array<{
      appid: number;
      name: string;
    }>;
  };
}

// === Steam API 클라이언트 ===

export class SteamApiClient {
  private static readonly logger = new Logger(SteamApiClient.name);

  /**
   * Steam DLC 이름 조회
   */
  static async getDlcName(steamId: number): Promise<string | null> {
    try {
      const response = await axios.get<SteamAppDetailsResponse>(
        `${STEAM_API.APPDETAILS_URL}?appids=${steamId}&l=korean&cc=KR`,
        {
          timeout: STEAM_API.DLC_TIMEOUT,
          headers: {
            'User-Agent': STEAM_API.USER_AGENT,
          },
        },
      );

      const appData = response.data[steamId.toString()];

      if (!appData || !appData.success || !appData.data) {
        return null;
      }

      return appData.data.name || null;
    } catch (error) {
      LoggerHelper.logApiFail(this.logger, 'Steam', 'getDlcName', error);
      return null;
    }
  }

  /**
   * Steam App 목록 조회
   */
  static async getSteamAppList(): Promise<Array<{ appid: number; name: string }> | null> {
    try {
      LoggerHelper.logApiCall(this.logger, 'Steam', 'GetAppList');

      const response = await axios.get<SteamAppListResponse>(
        STEAM_API.APPLIST_URL,
        {
          timeout: STEAM_API.DEFAULT_TIMEOUT,
          headers: {
            'User-Agent': STEAM_API.USER_AGENT,
          },
        },
      );

      if (!response.data?.applist?.apps) {
        LoggerHelper.logWarning(this.logger, 'Steam 앱 목록', '응답이 올바르지 않음');
        return null;
      }

      LoggerHelper.logApiSuccess(this.logger, 'Steam', 'GetAppList', `${response.data.applist.apps.length}개 앱`);
      return response.data.applist.apps;
    } catch (error) {
      LoggerHelper.logApiFail(this.logger, 'Steam', 'GetAppList', error);
      return null;
    }
  }

  /**
   * Steam App 상세 정보 조회
   */
  static async getAppDetails(
    steamId: number,
    language: string = 'korean',
    countryCode: string = 'KR'
  ): Promise<any | null> {
    try {
      LoggerHelper.logApiCall(this.logger, 'Steam', 'AppDetails', steamId);

      const params = new URLSearchParams({
        appids: steamId.toString(),
        l: language,
        cc: countryCode,
      });

      const response = await axios.get<SteamAppDetailsResponse>(
        `${STEAM_API.APPDETAILS_URL}?${params.toString()}`,
        {
          timeout: STEAM_API.DEFAULT_TIMEOUT,
          headers: {
            'User-Agent': STEAM_API.USER_AGENT,
          },
        },
      );

      const appData = response.data[steamId.toString()];

      if (!appData || !appData.success || !appData.data) {
        LoggerHelper.logWarning(this.logger, 'Steam AppDetails', '응답 실패 또는 데이터 없음', steamId);
        return null;
      }

      LoggerHelper.logApiSuccess(this.logger, 'Steam', 'AppDetails', appData.data.name);
      return appData.data;
    } catch (error) {
      LoggerHelper.logApiFail(this.logger, 'Steam', 'AppDetails', error);
      return null;
    }
  }

  /**
   * Steam URL에서 App ID 추출
   */
  static extractSteamAppIdFromUrl(steamUrl: string): number | null {
    try {
      const steamUrlPattern = /store\.steampowered\.com\/app\/(\d+)/i;
      const match = steamUrl.match(steamUrlPattern);

      if (match && match[1]) {
        const appId = parseInt(match[1], 10);
        return isNaN(appId) ? null : appId;
      }

      return null;
    } catch (error) {
      LoggerHelper.logWarning(this.logger, 'Steam URL App ID 추출', '실패', steamUrl);
      return null;
    }
  }
}

// === 로깅 헬퍼 ===

export class LoggerHelper {

  /**
   * 작업 시작 로깅
   */
  static logStart(logger: Logger, operation: string, context?: any): void {
    const contextStr = context ? ` (${typeof context === 'object' ? JSON.stringify(context) : context})` : '';
    logger.log(`${operation} 시작${contextStr}`);
  }

  /**
   * 작업 완료 로깅
   */
  static logComplete(logger: Logger, operation: string, stats?: any): void {
    let statsStr = '';
    if (stats) {
      if (typeof stats === 'object') {
        const entries = Object.entries(stats).map(([key, value]) => `${key}: ${value}`);
        statsStr = ` - ${entries.join(', ')}`;
      } else {
        statsStr = ` - ${stats}`;
      }
    }
    logger.log(`${operation} 완료${statsStr}`);
  }

  /**
   * 작업 진행 중 로깅
   */
  static logProgress(logger: Logger, operation: string, step?: string | number, total?: number): void {
    let progressStr = '';
    if (step !== undefined) {
      if (total !== undefined) {
        progressStr = ` (${step}/${total})`;
      } else {
        progressStr = ` - ${step}`;
      }
    }
    logger.debug(`${operation} 중${progressStr}`);
  }

  /**
   * API 호출 시작 로깅
   */
  static logApiCall(logger: Logger, service: string, method: string, params?: any): void {
    const paramsStr = params ? ` - ${typeof params === 'object' ? JSON.stringify(params) : params}` : '';
    logger.debug(`${service} ${method} API 호출${paramsStr}`);
  }

  /**
   * API 호출 성공 로깅
   */
  static logApiSuccess(logger: Logger, service: string, method: string, result?: any): void {
    let resultStr = '';
    if (result !== undefined) {
      if (typeof result === 'object') {
        resultStr = ` (결과: ${JSON.stringify(result)})`;
      } else {
        resultStr = ` (결과: ${result})`;
      }
    }
    logger.debug(`${service} ${method} API 성공${resultStr}`);
  }

  /**
   * API 호출 실패 로깅
   */
  static logApiFail(logger: Logger, service: string, method: string, error: any): void {
    const errorMsg = error?.message || String(error);
    logger.warn(`${service} ${method} API 실패: ${errorMsg}`);
  }

  /**
   * 에러 로깅
   */
  static logError(logger: Logger, operation: string, error: any, context?: any): void {
    const errorMsg = error?.message || String(error);
    const contextStr = context ? ` (컨텍스트: ${typeof context === 'object' ? JSON.stringify(context) : context})` : '';
    logger.error(`${operation} 실패: ${errorMsg}${contextStr}`);
  }

  /**
   * 경고 로깅
   */
  static logWarning(logger: Logger, operation: string, reason: string, context?: any): void {
    const contextStr = context ? ` (${typeof context === 'object' ? JSON.stringify(context) : context})` : '';
    logger.warn(`${operation} 경고: ${reason}${contextStr}`);
  }

  /**
   * 검색 결과 로깅
   */
  static logSearchResult(logger: Logger, target: string, query: any, found: boolean, details?: any): void {
    const queryStr = typeof query === 'object' ? JSON.stringify(query) : String(query);
    const status = found ? '발견' : '없음';
    const detailsStr = details ? ` - ${typeof details === 'object' ? JSON.stringify(details) : details}` : '';
    logger.debug(`${target} 검색: "${queryStr}" → ${status}${detailsStr}`);
  }

  /**
   * 캐시 관련 로깅
   */
  static logCache(logger: Logger, action: 'hit' | 'miss' | 'update' | 'clear', target: string, details?: any): void {
    const actionMap = {
      hit: '캐시 사용',
      miss: '캐시 없음',
      update: '캐시 업데이트',
      clear: '캐시 정리'
    };
    const detailsStr = details ? ` (${typeof details === 'object' ? JSON.stringify(details) : details})` : '';
    logger.debug(`${target} ${actionMap[action]}${detailsStr}`);
  }

  /**
   * 통계 로깅
   */
  static logStats(logger: Logger, operation: string, stats: Record<string, any>, processingTime?: number): void {
    const statsEntries = Object.entries(stats).map(([key, value]) => `${key}: ${value}`);
    const timeStr = processingTime ? ` - ${processingTime}ms` : '';
    logger.log(`${operation} 통계: ${statsEntries.join(', ')}${timeStr}`);
  }

  /**
   * 분석 결과 로깅
   */
  static logAnalysis(logger: Logger, target: string, analysis: any, confidence?: number): void {
    const analysisStr = typeof analysis === 'object' ? JSON.stringify(analysis) : String(analysis);
    const confidenceStr = confidence ? ` (신뢰도: ${confidence.toFixed(2)})` : '';
    logger.debug(`${target} 분석: ${analysisStr}${confidenceStr}`);
  }

  /**
   * 게임 처리 관련 로깅 (도메인 특화)
   */
  static logGameProcessing(logger: Logger, gameName: string, action: string, result?: any): void {
    const resultStr = result ? ` → ${typeof result === 'object' ? JSON.stringify(result) : result}` : '';
    logger.debug(`게임 ${action}: ${gameName}${resultStr}`);
  }

  /**
   * 매칭 결과 로깅 (도메인 특화)
   */
  static logMatch(logger: Logger, source: string, target: string, success: boolean, similarity?: number, reason?: string): void {
    const status = success ? '매칭 성공' : '매칭 실패';
    const similarityStr = similarity ? ` (유사도: ${(similarity * 100).toFixed(1)}%)` : '';
    const reasonStr = reason ? ` - ${reason}` : '';
    logger.debug(`${source} → ${target}: ${status}${similarityStr}${reasonStr}`);
  }

  /**
   * 스킵 로깅
   */
  static logSkip(logger: Logger, target: string, reason: string): void {
    logger.debug(`${target} 스킵: ${reason}`);
  }

  /**
   * 재시도 로깅
   */
  static logRetry(logger: Logger, operation: string, attempt: number, maxAttempts: number, reason?: string): void {
    const reasonStr = reason ? ` (${reason})` : '';
    logger.warn(`${operation} 재시도 ${attempt}/${maxAttempts}${reasonStr}`);
  }
}