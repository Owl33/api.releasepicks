import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { RawgParentHint, RawgAdditionData } from '../types/game-calendar-unified.types';
import { ErrorHandlerUtil } from '../common/utils/error-handler.util';
import { RAWG_API } from '../common/constants/api.constants';

@Injectable()
export class RawgService {
  private readonly logger = new Logger(RawgService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    this.baseUrl =
      this.configService.get<string>('RAWG_API_BASE_URL') ||
      'https://api.rawg.io/api';
    this.apiKey = this.configService.get<string>('RAWG_API_KEY') || '';
  }

  // 🚀 다중 페이지 월별 게임 데이터 조회
  async getMonthlyGames(month: string, maxGames: number = 200) {
    return ErrorHandlerUtil.executeRawgApiCall(
      async () => {
        // 동적 날짜 범위 계산
        const [year, monthNum] = month.split('-');
        const startDate = `${year}-${monthNum.padStart(2, '0')}-01`;
        const lastDay = new Date(
          parseInt(year),
          parseInt(monthNum),
          0,
        ).getDate();
        const endDate = `${year}-${monthNum.padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;

        const allGames: any[] = [];
        let page = 1;
        let totalCount = 0;
        const pageSize = 40;

        let apiCalls = 0;

        while (allGames.length < maxGames) {
          // 🔄 통합 시스템: 로깅은 ErrorHandlerUtil과 GlobalExceptionFilter에서 처리
          const response = await axios.get(`${this.baseUrl}/games`, {
            params: {
              key: this.apiKey,
              dates: `${startDate},${endDate}`,
              page_size: Math.min(pageSize, maxGames - allGames.length),
              page: page,
              ordering: '-added',
            },
            timeout: RAWG_API.DETAILS_TIMEOUT,
          });
          const { count, results, next } = response.data;
          totalCount = count;
          apiCalls += 1;

          if (!results || results.length === 0) {
            // 🔄 통합 시스템: 정보성 로그도 통합 시스템에서 처리
            break;
          }

          // added >= 3 필터링
          const filteredResults = results.filter((r) => r.added >= 3);
          allGames.push(...filteredResults);

          // 🔄 통합 시스템: 페이지 진행 로그도 통합 시스템에서 처리

          // 다음 페이지가 없거나 원하는 개수에 도달하면 종료
          if (!next || allGames.length >= maxGames) {
            break;
          }

          page++;
        }

        // 🔄 통합 시스템: 완료 로그도 통합 시스템에서 처리

        return {
          totalCount,
          games: allGames.slice(0, maxGames), // 최대 개수 제한
          page,
          pageSize: allGames.length,
          apiCalls,
        };
      },
      this.logger,
      '월별 게임 조회',
      month,
    );
  }

  async getStore(gameId: number) {
    return ErrorHandlerUtil.executeRawgApiCall(
      async () => {
        const response = await axios.get(
          `${this.baseUrl}/games/${gameId}/stores`,
          {
            params: {
              key: this.apiKey,
            },
            timeout: RAWG_API.STORES_TIMEOUT,
          },
        );
        return response.data;
      },
      this.logger,
      'getStore',
      gameId,
    );
  }
  async getDevloper(gameId: number) {
    return ErrorHandlerUtil.executeRawgApiCall(
      async () => {
        const response = await axios.get(
          `${this.baseUrl}/developers/${gameId}`,
          {
            params: {
              key: this.apiKey,
            },
            timeout: RAWG_API.DETAILS_TIMEOUT,
          },
        );
        return response.data;
      },
      this.logger,
      'getDeveloper',
      gameId,
    );
  }

  // ❌ 레거시 getMonthlyCalendarData() 메서드 제거됨
  // → GameCalendarCollectionService.collectGamesForMonth() 사용

  // ❌ convertRawgForDatabase 메서드 제거됨 - UnifiedGameService에서 처리

  // ❌ getStoreLinks 메소드 제거됨 - UnifiedGameService로 이관

  // ❌ getYouTubeTrailer 메소드 제거됨 - UnifiedGameService로 이관
  async getDetails(gameId: number) {
    return ErrorHandlerUtil.executeRawgApiCall(
      async () => {
        const response = await axios.get(`${this.baseUrl}/games/${gameId}`, {
          params: {
            key: this.apiKey,
          },
          timeout: RAWG_API.DETAILS_TIMEOUT,
        });
        const results = response.data;
        return {
          slugName: results.slug,
          website: results.website,
          developers: results.developers?.map((d) => d.name) || [],
          publishers: results.publishers?.map((p) => p.name) || [],
          // 🎯 DLC 판별을 위한 중요 필드들 추가
          parents_count: results.parents_count,
          additions_count: results.additions_count,
        };
      },
      this.logger,
      'getDetails',
      gameId,
    );
  }

  async getParentGames(gameId: number): Promise<RawgParentHint[]> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        const response = await axios.get(
          `${this.baseUrl}/games/${gameId}/parent-games`,
          {
            params: {
              key: this.apiKey,
            },
            timeout: RAWG_API.STORES_TIMEOUT,
          },
        );
        const results = Array.isArray(response.data.results)
          ? response.data.results
          : [];
        return results
          .filter((parent) => parent && typeof parent.id === 'number')
          .map((parent) => ({
            id: parent.id,
            name: typeof parent.name === 'string' ? parent.name : '',
            slug:
              typeof parent.slug === 'string' && parent.slug.length > 0
                ? parent.slug
                : null,
            platforms: this.normalizeParentPlatforms(parent.platforms),
            background_image:
              typeof parent.background_image === 'string' &&
              parent.background_image.length > 0
                ? parent.background_image
                : null,
          }));
      },
      this.logger,
      {
        context: 'RAWG parent-games API',
        identifier: gameId.toString(),
        rethrow: false, // 에러 시 null 반환, 빈 배열로 대체
        defaultMessage: '부모 게임 조회 실패',
      },
    ).then((result) => result || []); // null인 경우 빈 배열 반환
  }

  private normalizeParentPlatforms(platforms: any): string[] {
    if (!Array.isArray(platforms)) {
      return [];
    }

    const normalized: string[] = [];

    for (const platform of platforms) {
      if (!platform) {
        continue;
      }

      let slug: string | null = null;

      if (typeof platform === 'string') {
        slug = platform;
      } else if (platform.platform) {
        const raw = platform.platform.slug || platform.platform.name;
        slug = raw ? String(raw) : null;
      } else if (platform.slug || platform.name) {
        slug = String(platform.slug || platform.name);
      }

      if (!slug) {
        continue;
      }

      const lower = slug.toLowerCase();
      if (!normalized.includes(lower)) {
        normalized.push(lower);
      }
    }

    return normalized;
  }

  /**
   * RAWG additions API 호출
   * 게임의 추가 콘텐츠(pc port?, 확장팩) 정보 조회
   */
  async getAdditions(gameId: number): Promise<RawgAdditionData[]> {
    return ErrorHandlerUtil.executeWithErrorHandling(
      async () => {
        const response = await axios.get(
          `${this.baseUrl}/games/${gameId}/additions`,
          {
            params: {
              key: this.apiKey,
            },
            timeout: RAWG_API.STORES_TIMEOUT,
          },
        );
        return response.data.results || [];
      },
      this.logger,
      {
        context: 'RAWG additions API',
        identifier: gameId.toString(),
        rethrow: false, // 에러 시 null 반환, 빈 배열로 대체
        defaultMessage: '추가 콘텐츠 조회 실패',
      },
    ).then((result) => result || []); // null인 경우 빈 배열 반환
  }
}
