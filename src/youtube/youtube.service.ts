import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  YouTubeSearchItem,
  YouTubeSearchResponse,
  YouTubeSearchFilters,
  TrailerConfidenceScore,
  GameTrailerResult,
  YouTubeApiConfig,
  QueryGenerationOptions,
  YouTubeServiceStats,
} from '../types/youtube.types';
import { YouTubeTrailer } from '../types/game-calendar.types';

@Injectable()
export class YouTubeService {
  private readonly logger = new Logger(YouTubeService.name);
  private readonly apiConfig: YouTubeApiConfig;

  // 🚀 SIMPLIFIED: 통계 추적 제거

  // 🚀 SIMPLIFIED: 키워드 배열 단순화
  private readonly officialChannelKeywords = [
    'official',
    'playstation',
    'xbox',
    'nintendo',
  ];
  private readonly trailerKeywords = ['trailer', 'official trailer'];
  private readonly excludeKeywords = [
    'review',
    'reaction',
    'walkthrough',
    'guide',
  ];

  constructor(private configService: ConfigService) {
    // 🚀 SIMPLIFIED: API 설정 단순화
    this.apiConfig = {
      apiKey: this.configService.get<string>('YOUTUBE_API_KEY') || '',
      baseUrl: 'https://www.googleapis.com/youtube/v3',
      quotaLimit: 10000,
      quotaUsed: 0,
      cacheTTL: 24 * 60 * 60 * 1000,
      retryCount: 2,
      timeout: 10000,
    };
  }

  /**
   * 게임 공식 트레일러 검색 (메인 메서드)
   */
  // 🚀 SIMPLIFIED: 단순화된 트레일러 검색
  async findGameTrailer(
    gameName: string,
    options: Partial<YouTubeSearchFilters> = {},
  ): Promise<GameTrailerResult> {
    this.logger.log(`YouTube 트레일러 검색: ${gameName}`);

    try {
      // 기본 검색 쿼리
      const query = `${gameName} official trailer`;
      const searchResults = await this.searchVideos(query, options);
      if (searchResults.items.length === 0) {
        return {
          gameName,
          searchDate: new Date().toISOString(),
          alternativeTrailers: [],
          searchAttempts: 1,
          searchQueries: [query],
          noTrailerFound: true,
        };
      }

      // 첫 번째 결과를 최고 트레일러로 선택
      const bestTrailer = {
        ...searchResults.items[0],
        confidenceScore: this.calculateSimpleConfidence(
          searchResults.items[0],
          gameName,
        ),
      };
      return {
        gameName,
        searchDate: new Date().toISOString(),
        bestTrailer,
        alternativeTrailers: searchResults.items.slice(1, 3).map((item) => ({
          ...item,
          confidenceScore: this.calculateSimpleConfidence(item, gameName),
        })), // 상위 2개 대안
        searchAttempts: 1,
        searchQueries: [query],
        noTrailerFound: false,
      };
    } catch (error) {
      this.logger.error(
        `YouTube 트레일러 검색 실패: ${gameName}`,
        error.message,
      );
      return {
        gameName,
        searchDate: new Date().toISOString(),
        alternativeTrailers: [],
        searchAttempts: 0,
        searchQueries: [],
        noTrailerFound: true,
        errorMessage: error.message,
      };
    }
  }

  /**
   * 간단한 트레일러 조회 (GameCalendarService용) - YouTube 링크만 반환
   */
  async getSimpleTrailer(gameName: string): Promise<string | undefined> {
    try {
      const result = await this.findGameTrailer(gameName, {
        maxResults: 1,
        includeKeywords: ['trailer'],
        excludeKeywords: this.excludeKeywords,
      });

      if (
        result.bestTrailer &&
        result.bestTrailer.confidenceScore.totalScore >= 0.6
      ) {
        return `https://www.youtube.com/watch?v=${result.bestTrailer.videoId}`;
      }

      return undefined;
    } catch (error) {
      this.logger.warn(`간단한 트레일러 조회 실패: ${gameName}`, error.message);
      return undefined;
    }
  }

  /**
   * YouTube API로 비디오 검색
   */
  private async searchVideos(
    query: string,
    options: Partial<YouTubeSearchFilters>,
  ): Promise<YouTubeSearchResponse> {
    const searchParams = {
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: options.maxResults || 10,
      order: options.sortBy || 'relevance',
      safeSearch: options.safeSearch || 'none',
      key: this.apiConfig.apiKey,
    };

    // 날짜 필터 추가
    if (options.publishedAfter) {
      searchParams['publishedAfter'] = options.publishedAfter;
    }
    if (options.publishedBefore) {
      searchParams['publishedBefore'] = options.publishedBefore;
    }

    try {
      const response = await axios.get(`${this.apiConfig.baseUrl}/search`, {
        params: searchParams,
        timeout: this.apiConfig.timeout,
      });
      const items: YouTubeSearchItem[] = response.data.items.map(
        (item: any) => ({
          videoId: item.id.videoId,
          title: item.snippet.title,
          description: item.snippet.description,
          thumbnailUrl:
            item.snippet.thumbnails.high?.url ||
            item.snippet.thumbnails.default.url,
          publishedAt: item.snippet.publishedAt,
          channelId: item.snippet.channelId,
          channelTitle: item.snippet.channelTitle,
        }),
      );

      return {
        gameName: '',
        searchQuery: query,
        totalResults: response.data.pageInfo.totalResults,
        items,
        searchDate: new Date().toISOString(),
        filters: options as YouTubeSearchFilters,
      };
    } catch (error) {
      throw new Error(`YouTube API 검색 실패: ${error.message}`);
    }
  }

  // 🚀 SIMPLIFIED: 복잡한 쿼리 생성 제거 (단일 쿼리만 사용)

  // 🚀 SIMPLIFIED: 간단한 신뢰도 계산
  private calculateSimpleConfidence(
    item: YouTubeSearchItem,
    gameName: string,
  ): TrailerConfidenceScore {
    const titleMatch = item.title
      .toLowerCase()
      .includes(gameName.toLowerCase());
    const hasTrailerKeyword = item.title.toLowerCase().includes('trailer');
    const isOfficialChannel = this.officialChannelKeywords.some((keyword) =>
      item.channelTitle.toLowerCase().includes(keyword),
    );

    const totalScore =
      (titleMatch ? 0.5 : 0) +
      (hasTrailerKeyword ? 0.3 : 0) +
      (isOfficialChannel ? 0.2 : 0);

    return {
      videoId: item.videoId,
      totalScore,
      factors: {
        titleMatch: titleMatch ? 1.0 : 0.0,
        channelCredibility: isOfficialChannel ? 0.9 : 0.3,
        keywords: hasTrailerKeyword ? 0.8 : 0.2,
        duration: 0.8,
        viewCount: 0.7,
        publishDate: 1.0,
      },
      isOfficialTrailer: isOfficialChannel && hasTrailerKeyword,
      confidence:
        totalScore > 0.7 ? 'high' : totalScore > 0.4 ? 'medium' : 'low',
    };
  }
}
