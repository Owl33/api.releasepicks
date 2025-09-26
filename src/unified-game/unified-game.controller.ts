import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Logger,
  ParseIntPipe,
} from '@nestjs/common';
import {
  PatchUpdateResult,
  UnifiedGameService,
} from './unified-game.service';
import { LoggerHelper } from '../common/utils/logger.helper';
import {
  GameCalendarData,
  MonthlyUnifiedGameResult,
  UnifiedGameOptions,
} from '../types/game-calendar-unified.types';
import type { UpdateGameDto } from './dto/update-game.dto';

/**
 * 통합 게임 캘린더 컨트롤러
 * user_request.md 명세 구현: 최종적으로 save와 get 두 가지 API만 제공
 *
 * 핵심 원칙:
 * - 하나의 논리로 동작
 * - save/get 두 가지 API만
 * - RAWG + Steam + Reviews 통합 처리
 */
@Controller('unified-games')
export class UnifiedGameController {
  private readonly logger = new Logger(UnifiedGameController.name);

  constructor(private readonly unifiedGameService: UnifiedGameService) {}

  /**
   * 🔍 GET API: 월별 통합 게임 데이터 조회
   * RAWG + Steam + Reviews를 통합한 최종 데이터 반환
   *
   * @param month - YYYY-MM 형식 (예: 2025-01)
   * @param maxGames - 최대 게임 수 (기본값: 20)
   * @param enableSteamIntegration - Steam 통합 활성화 (기본값: true)
   */
  @Get(':month')
  async getMonthlyGames(
    @Param('month') month: string,
    @Query('maxGames') maxGames?: string,
    @Query('enableSteamIntegration') enableSteamIntegration?: string,
    @Query('minPopularity') minPopularity?: string,
    @Query('steamTimeout') steamTimeout?: string,
  ): Promise<MonthlyUnifiedGameResult> {
    LoggerHelper.logStart(
      this.logger,
      'GET 요청',
      `${month} 월별 통합 게임 데이터 조회`,
    );

    // 쿼리 파라미터 파싱
    const options: UnifiedGameOptions = {
      max_games: maxGames ? parseInt(maxGames, 10) : 20,
      enable_steam_integration:
        enableSteamIntegration !== undefined
          ? enableSteamIntegration === 'true'
          : true,
      min_popularity: minPopularity ? parseInt(minPopularity, 10) : 3,
      steam_timeout: steamTimeout ? parseInt(steamTimeout, 10) : 10000,
      include_early_access: true, // 기본값
    };

    try {
      const result = await this.unifiedGameService.processGamesForMonth(
        month,
        options,
      );

      LoggerHelper.logComplete(
        this.logger,
        `GET 완료: ${month}`,
        `${result.total_games}개 게임 (PC: ${result.pc_games}, 콘솔: ${result.console_games}, Steam 통합: ${result.steam_integrated_games}개)`,
      );

      return result;
    } catch (error) {
      LoggerHelper.logError(this.logger, 'GET 실패', error, month);
      throw error;
    }
  }

  /**
   * 💾 POST API: 월별 통합 게임 데이터 저장
   * RAWG + Steam + Reviews 통합 처리 후 데이터베이스에 저장
   *
   * @param month - YYYY-MM 형식 (예: 2025-01)
   * @param maxGames - 최대 게임 수 (기본값: 20)
   * @param enableSteamIntegration - Steam 통합 활성화 (기본값: true)
   * @param minPopularity - 최소 인기도 (기본값: 3)
   * @param steamTimeout - Steam API 타임아웃 (기본값: 10000ms)
   */
  @Post('save/:month')
  async saveMonthlyGames(
    @Param('month') month: string,
    @Query('maxGames') maxGames?: string,
    @Query('enableSteamIntegration') enableSteamIntegration?: string,
    @Query('minPopularity') minPopularity?: string,
    @Query('steamTimeout') steamTimeout?: string,
  ): Promise<{
    saved: number;
    skipped: number;
    errors: number;
    message: string;
  }> {
    LoggerHelper.logStart(
      this.logger,
      'POST 요청',
      `${month} 월별 통합 게임 데이터 저장`,
    );

    // 쿼리 파라미터 파싱 (GET과 동일)
    const options: UnifiedGameOptions = {
      max_games: maxGames ? parseInt(maxGames, 10) : 20,
      enable_steam_integration:
        enableSteamIntegration !== undefined
          ? enableSteamIntegration === 'true'
          : true,
      min_popularity: minPopularity ? parseInt(minPopularity, 10) : 3,
      steam_timeout: steamTimeout ? parseInt(steamTimeout, 10) : 10000,
      include_early_access: true,
    };

    try {
      const result = await this.unifiedGameService.saveUnifiedGamesToDatabase(
        month,
        options,
      );

      const message = `${month} 월별 게임 저장 완료: 저장 ${result.saved}개, 건너뜀 ${result.skipped}개, 오류 ${result.errors}개`;

      LoggerHelper.logComplete(this.logger, 'POST 완료', message);

      return {
        ...result,
        message,
      };
    } catch (error) {
      LoggerHelper.logError(this.logger, 'POST 실패', error, month);
      throw error;
    }
  }

  /**
   * ✏️ PATCH API: 단일 게임 부분 업데이트
   */
  @Patch('games/:rawgId')
  async patchGame(
    @Param('rawgId', ParseIntPipe) rawgId: number,
    @Body() payload: UpdateGameDto,
  ): Promise<PatchUpdateResult> {
    LoggerHelper.logStart(
      this.logger,
      'PATCH 요청',
      `rawg_id=${rawgId} 부분 업데이트`,
    );

    const result = await this.unifiedGameService.updateGame(rawgId, payload);

    LoggerHelper.logComplete(
      this.logger,
      'PATCH 완료',
      `rawg_id=${rawgId}, updated_fields=${result.updated_fields.join(',')}`,
    );

    return result;
  }

  /**
   * 📊 GET API: 처리 상태 조회
   * 통합 서비스의 상태 및 통계 정보 조회
   */
  @Get('health/status')
  async getProcessingStatus(): Promise<{
    status: string;
    timestamp: Date;
    services: {
      rawg: boolean;
      steam: boolean;
      youtube: boolean;
    };
  }> {
    LoggerHelper.logStart(this.logger, '처리 상태 조회', '요청');

    try {
      // 각 서비스 상태 체크 (간단한 형태)
      return {
        status: 'healthy',
        timestamp: new Date(),
        services: {
          rawg: true, // TODO: RawgService 상태 체크
          steam: true, // TODO: SteamService 상태 체크
          youtube: true, // TODO: YouTubeService 상태 체크
        },
      };
    } catch (error) {
      LoggerHelper.logError(this.logger, '처리 상태 조회 실패', error);
      return {
        status: 'unhealthy',
        timestamp: new Date(),
        services: {
          rawg: false,
          steam: false,
          youtube: false,
        },
      };
    }
  }

  /**
   * 🗑️ POST API: 배치 캐시 클리어
   * 디버깅 및 새로운 데이터 갱신을 위한 캐시 클리어
   */
  @Post('clear-cache')
  async clearBatchCache(): Promise<{ message: string; timestamp: Date }> {
    LoggerHelper.logStart(this.logger, '배치 캐시 클리어', '요청');

    try {
      await this.unifiedGameService.clearBatchCache();
      return {
        message: '배치 캐시가 성공적으로 클리어되었습니다.',
        timestamp: new Date(),
      };
    } catch (error) {
      LoggerHelper.logError(this.logger, '배치 캐시 클리어 실패', error);
      throw error;
    }
  }
}
