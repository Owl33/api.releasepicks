import {
  Controller,
  Get,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { StreamlinedSteamService } from './steam.service';
import { SteamApiOptions } from '../types/steam.types';

/**
 * Steam API 테스트용 컨트롤러
 * 개발 및 디버깅을 위한 엔드포인트 제공
 */
@Controller('steam')
export class SteamController {
  constructor(private readonly steamService: StreamlinedSteamService) {}

  /**
   * 게임명으로 Steam ID 검색 테스트
   * GET /steam/search/{gameName}
   */
  @Get('search/:gameName')
  async searchSteamId(@Param('gameName') gameName: string) {
    try {
      const result = await this.steamService.findSteamId(gameName);

      if (!result.success) {
        throw new HttpException(
          {
            message: 'Steam ID를 찾을 수 없습니다',
            query: result.original_query,
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          message: 'Steam ID 검색 중 오류가 발생했습니다',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Steam ID로 게임 캘린더 데이터 조회 테스트
   * GET /steam/game/{steamId}
   */
  @Get('game/:steamId')
  async getGameData(
    @Param('steamId') steamId: string,
    @Query('lang') language?: string,
    @Query('cc') countryCode?: string,
  ) {
    try {
      const steamIdNumber = parseInt(steamId, 10);

      if (isNaN(steamIdNumber)) {
        throw new HttpException(
          {
            message: '올바른 Steam ID를 입력해주세요',
            provided: steamId,
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const options: SteamApiOptions = {};
      if (language) options.language = language;
      if (countryCode) options.country_code = countryCode;

      const gameData = await this.steamService.getGameCalendarData(
        steamIdNumber,
        options,
      );

      if (!gameData) {
        throw new HttpException(
          {
            message: 'Steam 게임 데이터를 찾을 수 없습니다',
            steamId: steamIdNumber,
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        data: gameData,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          message: 'Steam 게임 데이터 조회 중 오류가 발생했습니다',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 게임명으로 전체 Steam 데이터 조회 (검색 + 데이터 조회 통합)
   * GET /steam/full/{gameName}
   */
  @Get('full/:gameName')
  async getFullGameData(
    @Param('gameName') gameName: string,
    @Query('lang') language?: string,
    @Query('cc') countryCode?: string,
  ) {
    try {
      // 1단계: Steam ID 검색
      const searchResult = await this.steamService.findSteamId(gameName);

      if (!searchResult.success || !searchResult.steam_id) {
        throw new HttpException(
          {
            message: 'Steam에서 해당 게임을 찾을 수 없습니다',
            query: gameName,
            searchResult,
          },
          HttpStatus.NOT_FOUND,
        );
      }

      // 2단계: 게임 데이터 조회
      const options: SteamApiOptions = {};
      if (language) options.language = language;
      if (countryCode) options.country_code = countryCode;

      const gameData = await this.steamService.getGameCalendarData(
        searchResult.steam_id,
        options,
      );

      if (!gameData) {
        throw new HttpException(
          {
            message: 'Steam 게임 데이터를 조회할 수 없습니다',
            steam_id: searchResult.steam_id,
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        searchInfo: {
          originalQuery: gameName,
          found_name: searchResult.found_name,
          match_score: searchResult.match_score,
          steam_id: searchResult.steam_id,
        },
        data: gameData,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          message: 'Steam 전체 데이터 조회 중 오류가 발생했습니다',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Steam API 상태 체크
   * GET /steam/health
   */
  @Get('health')
  async checkHealth() {
    try {
      const healthStatus = await this.steamService.checkSteamApiHealth();

      return {
        success: true,
        health: healthStatus,
      };
    } catch (error) {
      throw new HttpException(
        {
          message: 'Steam API 상태 확인 중 오류가 발생했습니다',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
