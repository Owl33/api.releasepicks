import {
  Controller,
  Get,
  Param,
  Query,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { YouTubeService } from './youtube.service';
import { YouTubeSearchFilters } from '../types/youtube.types';
import { ApiResponse } from '../types/game-calendar-unified.types';

@Controller('youtube')
export class YouTubeController {
  constructor(private readonly youtubeService: YouTubeService) {}

  /**
   * 게임 공식 트레일러 검색
   * GET /youtube/trailer/:gameName
   *
   * @param gameName - 게임명
   * @param query - 검색 옵션
   */

  /**
   * 간단한 트레일러 조회 (게임 캘린더용)
   * GET /youtube/simple/:gameName
   *
   * @param gameName - 게임명
   */
  @Get('simple/:gameName')
  async getSimpleTrailer(@Param('gameName') gameName: string) {
    try {
      if (!gameName || gameName.trim().length === 0) {
        throw new HttpException(
          '게임명을 입력해주세요',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.youtubeService.getSimpleTrailer(
        decodeURIComponent(gameName),
      );

      const response: ApiResponse<typeof result> = {
        success: true,
        message: result
          ? `${gameName}의 YouTube 트레일러를 찾았습니다`
          : `${gameName}의 YouTube 트레일러를 찾을 수 없습니다`,
        data: result,
        timestamp: new Date().toISOString(),
      };

      return response;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        `간단한 트레일러 조회 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
