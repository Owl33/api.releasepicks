import { Injectable, Logger } from '@nestjs/common';
import {
  YouTubeSearchItem,
  YouTubeSearchFilters,
  TrailerConfidenceScore,
  GameTrailerResult,
} from '../types/youtube.types';

// 🔥 NEW: youtube-sr 패키지 import (quota 없는 YouTube 검색)
const YouTube = require('youtube-sr').default;

@Injectable()
export class YouTubeService {
  private readonly logger = new Logger(YouTubeService.name);

  // 🔥 NEW: youtube-sr 기반 키워드 필터링
  private readonly officialChannelKeywords = [
    'official',
    'playstation',
    'xbox',
    'nintendo',
    'team cherry', // 개발사 추가
    'ubisoft',
    'ea',
    'activision',
    'bethesda',
  ];
  private readonly trailerKeywords = [
    'trailer',
    'official trailer',
    'gameplay trailer',
    'launch trailer',
  ];
  private readonly excludeKeywords = [
    'review',
    'reaction',
    'walkthrough',
    'guide',
    'mod',
    'fan made',
    'speedrun',
  ];

  constructor() {
    this.logger.log(
      '🎬 YouTubeService 초기화: youtube-sr 패키지 사용 (quota 없음)',
    );
  }

  /**
   * 게임 공식 트레일러 검색 (메인 메서드)
   * 🔥 NEW: youtube-sr 패키지 사용 (quota 없음)
   */
  async findGameTrailer(
    gameName: string,
    options: Partial<YouTubeSearchFilters> = {},
  ): Promise<GameTrailerResult> {
    // this.logger.log(`🎬 YouTube 트레일러 검색 (youtube-sr): ${gameName}`);

    try {
      // 다양한 검색 쿼리 시도
      const queries = [
        `${gameName} official trailer`,
        `${gameName} gameplay trailer`,
        `${gameName} launch trailer`,
        `${gameName} trailer`,
      ];

      const allVideos: any[] = [];
      const successfulQueries: string[] = [];

      for (const query of queries) {
        try {
          this.logger.debug(`검색 시도: "${query}"`);
          const videos = await YouTube.search(query, { limit: 5 });

          if (videos && videos.length > 0) {
            allVideos.push(...videos);
            successfulQueries.push(query);
            this.logger.debug(`"${query}" 검색 결과: ${videos.length}개`);
          }
        } catch (queryError) {
          this.logger.warn(
            `검색 쿼리 실패: "${query}" - ${queryError.message}`,
          );
          continue;
        }
      }

      if (allVideos.length === 0) {
        return {
          gameName,
          searchDate: new Date().toISOString(),
          alternativeTrailers: [],
          searchAttempts: queries.length,
          searchQueries: queries,
          noTrailerFound: true,
        };
      }

      // 중복 제거 (비디오 ID 기준)
      const uniqueVideos = allVideos.filter(
        (video, index, self) =>
          index === self.findIndex((v) => v.id === video.id),
      );

      // youtube-sr 결과를 YouTubeSearchItem 형식으로 변환
      const convertedItems = uniqueVideos.map((video) =>
        this.convertYoutubeSrToSearchItem(video),
      );

      // 신뢰도 계산 및 정렬
      const scoredItems = convertedItems
        .map((item) => ({
          ...item,
          confidenceScore: this.calculateSimpleConfidence(item, gameName),
        }))
        .sort(
          (a, b) => b.confidenceScore.totalScore - a.confidenceScore.totalScore,
        );

      const bestTrailer = scoredItems[0];
      const alternativeTrailers = scoredItems.slice(1, 4); // 상위 3개 대안

      // this.logger.log(
      //   `🎆 최고 트레일러 발견: "${bestTrailer.title}" (신뢰도: ${bestTrailer.confidenceScore.totalScore.toFixed(2)})`,
      // );

      return {
        gameName,
        searchDate: new Date().toISOString(),
        bestTrailer,
        alternativeTrailers,
        searchAttempts: successfulQueries.length,
        searchQueries: successfulQueries,
        noTrailerFound: false,
      };
    } catch (error) {
      // this.logger.error(
      //   `❌ YouTube 트레일러 검색 실패: ${gameName}`,
      //   error.message,
      // );
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
   * 간단한 트레일러 조회 (RawgService용) - YouTube 비디오 ID만 반환
   * 🔥 ENHANCED: 향상된 에러 처리 및 fallback 로직
   */
  async getSimpleTrailer(gameName: string): Promise<string | undefined> {
    // 입력 검증
    if (!gameName || gameName.trim().length === 0) {
      // this.logger.warn('❌ 유효하지 않은 게임명');
      return undefined;
    }

    const sanitizedGameName = this.sanitizeGameName(gameName);
    // this.logger.debug(`🎬 간단 트레일러 검색: ${sanitizedGameName}`);

    // 다중 검색 쿼리 전략 (fallback 포함)
    const searchStrategies = [
      `${sanitizedGameName} official trailer`,
      `${sanitizedGameName} trailer`,
      `${sanitizedGameName} gameplay`,
      sanitizedGameName, // 마지막 fallback
    ];

    // 재시도 로직 포함
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const query of searchStrategies) {
        try {
          this.logger.debug(`🔍 검색 시도 ${attempt + 1}: "${query}"`);

          const videos = await this.searchWithTimeout(query, 5000); // 5초 타임아웃

          if (videos && videos.length > 0) {
            const bestVideo = this.selectBestVideo(videos, sanitizedGameName);

            if (bestVideo && bestVideo.id) {
              // this.logger.debug(
              //   `✅ 트레일러 발견: "${bestVideo.title}" (ID: ${bestVideo.id}, 검색어: "${query}")`,
              // );
              return bestVideo.id;
            }
          }
        } catch (error) {
          // this.logger.debug(`⚠️ 검색 시도 실패: "${query}" - ${error.message}`);
          // 계속해서 다음 전략 시도
          continue;
        }
      }

      // 첫 번째 시도 실패 시 잠시 대기 후 재시도
      if (attempt === 0) {
        // this.logger.debug('🔄 첫 번째 시도 실패, 1초 후 재시도');
        await this.sleep(1000);
      }
    }

    this.logger.debug(`❌ 모든 검색 전략 실패: ${sanitizedGameName}`);
    return undefined;
  }

  /**
   * 게임명 정리 및 검증
   */
  private sanitizeGameName(gameName: string): string {
    return gameName
      .replace(/[:™®©]/g, '') // 특수 문자 제거
      .replace(/\s+/g, ' ') // 여러 공백을 하나로
      .trim()
      .substring(0, 100); // 최대 길이 제한
  }

  /**
   * 타임아웃이 포함된 검색
   */
  private async searchWithTimeout(
    query: string,
    timeoutMs: number,
  ): Promise<any[]> {
    return Promise.race([
      YouTube.search(query, { limit: 5 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('검색 타임아웃')), timeoutMs),
      ),
    ]) as Promise<any[]>;
  }

  /**
   * 비디오 선택 로직 (신뢰도 기반)
   */
  private selectBestVideo(videos: any[], gameName: string): any | null {
    if (!videos || videos.length === 0) return null;

    // 신뢰도 점수 계산
    const scoredVideos = videos.map((video) => ({
      ...video,
      score: this.calculateVideoScore(video, gameName),
    }));

    // 점수 순으로 정렬
    scoredVideos.sort((a, b) => b.score - a.score);

    // 최소 점수 기준 (0.3) 이상인 비디오만 반환
    const bestVideo = scoredVideos[0];
    return bestVideo && bestVideo.score >= 0.3 ? bestVideo : null;
  }

  /**
   * 비디오 신뢰도 점수 계산
   */
  private calculateVideoScore(video: any, gameName: string): number {
    let score = 0;
    const title = (video.title || '').toLowerCase();
    const channel = (video.channel?.name || '').toLowerCase();
    const normalizedGameName = gameName.toLowerCase();

    // 제목 매칭 (가장 중요)
    if (title.includes(normalizedGameName)) score += 0.6;

    // 트레일러 키워드
    if (this.trailerKeywords.some((keyword) => title.includes(keyword)))
      score += 0.3;

    // 공식 채널
    if (
      this.officialChannelKeywords.some((keyword) => channel.includes(keyword))
    )
      score += 0.2;

    // 제외 키워드 페널티
    if (this.excludeKeywords.some((keyword) => title.includes(keyword)))
      score -= 0.5;

    return Math.max(0, score);
  }

  /**
   * Sleep 유틸리티
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 🔥 NEW: youtube-sr 결과를 YouTubeSearchItem 형식으로 변환
   */
  private convertYoutubeSrToSearchItem(video: any): YouTubeSearchItem {
    return {
      videoId: video.id,
      title: video.title || 'Unknown Title',
      description: video.description || '',
      thumbnailUrl:
        video.thumbnail?.url ||
        `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`,
      publishedAt: video.uploadDate || new Date().toISOString(),
      channelId: video.channel?.id || '',
      channelTitle: video.channel?.name || 'Unknown Channel',
    };
  }

  /**
   * 🔥 NEW: 게임명 정규화 (더 나은 검색을 위해)
   */
  private normalizeGameName(gameName: string): string {
    return gameName
      .replace(/[:™®©]/g, '') // 특수 문자 제거
      .replace(/\s+/g, ' ') // 여러 공백을 하나로
      .trim();
  }

  /**
   * 🔥 IMPROVED: 향상된 신뢰도 계산 (youtube-sr 기반)
   */
  private calculateSimpleConfidence(
    item: YouTubeSearchItem,
    gameName: string,
  ): TrailerConfidenceScore {
    const normalizedGameName = this.normalizeGameName(gameName).toLowerCase();
    const normalizedTitle = item.title.toLowerCase();
    const normalizedChannel = item.channelTitle.toLowerCase();

    // 1. 제목 매칭 검사 (향상된 알고리즘)
    const exactTitleMatch = normalizedTitle.includes(normalizedGameName);
    const partialTitleMatch = normalizedGameName
      .split(' ')
      .some((word) => word.length > 2 && normalizedTitle.includes(word));
    const titleMatchScore = exactTitleMatch ? 0.6 : partialTitleMatch ? 0.3 : 0;

    // 2. 트레일러 키워드 검사
    const hasTrailerKeyword = this.trailerKeywords.some((keyword) =>
      normalizedTitle.includes(keyword),
    );
    const trailerScore = hasTrailerKeyword ? 0.4 : 0;

    // 3. 공식 채널 검사 (향상된 검사)
    const isOfficialChannel = this.officialChannelKeywords.some((keyword) =>
      normalizedChannel.includes(keyword),
    );
    const channelScore = isOfficialChannel ? 0.3 : 0;

    // 4. 제외 키워드 검사 (페널티)
    const hasExcludeKeyword = this.excludeKeywords.some((keyword) =>
      normalizedTitle.includes(keyword),
    );
    const excludePenalty = hasExcludeKeyword ? -0.5 : 0;

    // 5. 최종 점수 계산
    const totalScore = Math.max(
      0,
      titleMatchScore + trailerScore + channelScore + excludePenalty,
    );

    // 6. 디버깅 정보
    this.logger.debug(
      `신뢰도 계산: "${item.title}" - 점수: ${totalScore.toFixed(2)} (제목:${titleMatchScore}, 트레일러:${trailerScore}, 채널:${channelScore}, 페널티:${excludePenalty})`,
    );

    return {
      videoId: item.videoId,
      totalScore,
      factors: {
        titleMatch: exactTitleMatch ? 1.0 : partialTitleMatch ? 0.5 : 0.0,
        channelCredibility: isOfficialChannel ? 0.9 : 0.3,
        keywords: hasTrailerKeyword ? 0.9 : 0.1,
        duration: 0.8, // youtube-sr에서 제공되지 않으므로 기본값
        viewCount: 0.7, // youtube-sr에서 제공되지 않으므로 기본값
        publishDate: 1.0,
      },
      isOfficialTrailer: isOfficialChannel && hasTrailerKeyword,
      confidence:
        totalScore > 0.8 ? 'high' : totalScore > 0.5 ? 'medium' : 'low',
    };
  }
}
