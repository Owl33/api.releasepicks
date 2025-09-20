import { Controller, Get, Param, Query } from '@nestjs/common';
import { RawgService } from './rawg.service';
import { CalendarFilters } from '../types/game-calendar.types';

@Controller('rawg')
export class RawgController {
  constructor(private readonly rawgService: RawgService) {}

  @Get('released/:month')
  async getMonthlyCalendar(
    @Param('month') month: string,
    @Query() query: Partial<CalendarFilters>,
  ) {
    const result = await this.rawgService.getMonthlyCalendarData(month, query);
    return {
      success: true,
      message: `RAWG.io ${month} 완성된 게임 캘린더 데이터입니다`,
      data: {
        month,
        totalGames: result.games.length,
        games: result.games,
        pagination: {
          page: 1,
          pageSize: result.games.length,
          totalPages: 1,
        },
        filters: {
          minPopularity: query.minPopularity || 10,
          platforms: query.platforms || [],
          genres: query.genres || [],
        },
      },
      features: {
        rawgData: true,
        storeLinks: true,
        youtubeTrailers: true,
        filtering: true,
        sorting: true,
      },
    };
  }
}
