import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { GamesService } from './games.service';
import { CalendarResponseDto } from './dto/calendar.dto';
import { GameDetailResponseDto } from './dto/detail.dto';
import { HighlightsResponseDto } from './dto/highlights.dto';

/**
 * 프론트엔드에서 직접 호출하는 게임 전용 API 컨트롤러
 */
@Controller('api/games')
export class GamesController {
  constructor(private readonly gamesService: GamesService) {}

  @Get('calendar')
  async getCalendar(
    @Query('month') month?: string,
  ): Promise<CalendarResponseDto> {
    if (!month) {
      throw new BadRequestException('month 쿼리 파라미터는 필수입니다.');
    }

    return this.gamesService.getCalendarByMonth(month);
  }

  @Get('highlights')
  async getHighlights(
    @Query('upcomingLimit') upcomingLimit?: string,
    @Query('popularLimit') popularLimit?: string,
  ): Promise<HighlightsResponseDto> {
    const upcoming = this.parseLimit(upcomingLimit, 15, 'upcomingLimit');
    const popular = this.parseLimit(popularLimit, 15, 'popularLimit');

    return this.gamesService.getHighlights(upcoming, popular);
  }



  @Get(':id')
  async getGameDetail(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<GameDetailResponseDto> {
    return this.gamesService.getGameDetail(id);
  }

  /**
   * limit 파라미터를 10~20 범위로 보정하고 숫자가 아닐 경우 예외를 발생시킨다.
   */
  private parseLimit(
    value: string | undefined,
    defaultValue: number,
    key: string,
  ): number {
    if (value === undefined || value === null || value === '') {
      return defaultValue;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`${key} 파라미터는 숫자여야 합니다.`);
    }

    const floored = Math.floor(parsed);
    if (floored < 10 || floored > 20) {
      throw new BadRequestException(
        `${key} 파라미터는 10 이상 20 이하 범위만 허용됩니다.`,
      );
    }

    return floored;
  }
}
