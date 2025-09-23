import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { RawgParentGameData, RawgAdditionData } from '../types/game-calendar-unified.types';

@Injectable()
export class RawgService {
  private readonly logger = new Logger(RawgService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private configService: ConfigService,
  ) {
    this.baseUrl =
      this.configService.get<string>('RAWG_API_BASE_URL') ||
      'https://api.rawg.io/api';
    this.apiKey = this.configService.get<string>('RAWG_API_KEY') || '';
  }

  // 🚀 다중 페이지 월별 게임 데이터 조회
  async getMonthlyGames(month: string, maxGames: number = 200) {
    try {
      // 동적 날짜 범위 계산
      const [year, monthNum] = month.split('-');
      const startDate = `${year}-${monthNum.padStart(2, '0')}-01`;
      const lastDay = new Date(parseInt(year), parseInt(monthNum), 0).getDate();
      const endDate = `${year}-${monthNum.padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;

      const allGames: any[] = [];
      let page = 1;
      let totalCount = 0;
      const pageSize = 40;

      while (allGames.length < maxGames) {
        this.logger.debug(`RAWG ${month} ${page}페이지 조회 중... (대상: ${maxGames}개)`);

        const response = await axios.get(`${this.baseUrl}/games`, {
          params: {
            key: this.apiKey,
            dates: `${startDate},${endDate}`,
            page_size: Math.min(pageSize, maxGames - allGames.length),
            page: page,
            ordering: '-added',
          },
          timeout: 15000, // 타임아웃 증가
        });
        const { count, results, next } = response.data;
        totalCount = count;

        if (!results || results.length === 0) {
          this.logger.debug(`${page}페이지에서 데이터 없음, 종료`);
          break;
        }

        // added >= 3 필터링
        const filteredResults = results.filter((r) => r.added >= 3);
        allGames.push(...filteredResults);

        this.logger.debug(
          `${page}페이지: ${results.length}개 → 필터링 후 ${filteredResults.length}개 (누적: ${allGames.length}개)`,
        );

        // 다음 페이지가 없거나 원하는 개수에 도달하면 종료
        if (!next || allGames.length >= maxGames) {
          break;
        }

        page++;
      }

      this.logger.log(
        `RAWG ${month} 전체 조회 완료: ${allGames.length}개 수집 (총 ${totalCount}개 중, ${page}페이지)`,
      );

      return {
        totalCount,
        games: allGames.slice(0, maxGames), // 최대 개수 제한
        page,
        pageSize: allGames.length,
      };
    } catch (error) {
      this.logger.error('RAWG API 호출 실패:', error.message);
      throw new Error(`RAWG API 호출 실패: ${error.message}`);
    }
  }

  async getStore(gameId: number) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/games/${gameId}/stores`,
        {
          params: {
            key: this.apiKey,
          },
          timeout: 10000, // 타임아웃 추가
        },
      );
      return response.data;
    } catch (error) {
      this.logger.error('RAWG API 호출 실패:', error.message);
      throw new Error(`RAWG API 호출 실패: ${error.message}`);
    }
  }
  async getDevloper(gameId: number) {
    try {
      const response = await axios.get(`${this.baseUrl}/developers/${gameId}`, {
        params: {
          key: this.apiKey,
        },
      });

      return response.data;
    } catch (error) {
      this.logger.error('RAWG API 호출 실패:', error.message);
      throw new Error(`RAWG API 호출 실패: ${error.message}`);
    }
  }

  // ❌ 레거시 getMonthlyCalendarData() 메서드 제거됨
  // → GameCalendarCollectionService.collectGamesForMonth() 사용

  // ❌ convertRawgForDatabase 메서드 제거됨 - UnifiedGameService에서 처리

  // ❌ getStoreLinks 메소드 제거됨 - UnifiedGameService로 이관

  // ❌ getYouTubeTrailer 메소드 제거됨 - UnifiedGameService로 이관
  async getDetails(gameId: number) {
    try {
      const response = await axios.get(`${this.baseUrl}/games/${gameId}`, {
        params: {
          key: this.apiKey,
        },
        timeout: 10000, // 타임아웃 추가
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
    } catch (error) {
      this.logger.error('RAWG API 호출 실패:', error.message);
      throw new Error(`RAWG API 호출 실패: ${error.message}`);
    }
  }

  async getParentGames(gameId: number): Promise<RawgParentGameData[]> {
    try {
      this.logger.debug(`RAWG parent-games API 호출: ${gameId}`);
      const response = await axios.get(
        `${this.baseUrl}/games/${gameId}/parent-games`,
        {
          params: {
            key: this.apiKey,
          },
          timeout: 5000,
        },
      );

      return response.data.results || [];
    } catch (error) {
      this.logger.warn(`부모 게임 조회 실패: ${gameId}`, error.message);
      return [];
    }
  }

  /**
   * RAWG additions API 호출
   * 게임의 추가 콘텐츠(pc port?, 확장팩) 정보 조회
   */
  async getAdditions(gameId: number): Promise<RawgAdditionData[]> {
    try {
      this.logger.debug(`RAWG additions API 호출: ${gameId}`);
      const response = await axios.get(
        `${this.baseUrl}/games/${gameId}/additions`,
        {
          params: {
            key: this.apiKey,
          },
          timeout: 5000,
        },
      );

      return response.data.results || [];
    } catch (error) {
      this.logger.warn(`추가 콘텐츠 조회 실패: ${gameId}`, error.message);
      return [];
    }
  }


}
