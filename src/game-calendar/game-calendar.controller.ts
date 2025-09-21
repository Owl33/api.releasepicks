import { Controller, Get, Param } from '@nestjs/common';
import { GameCalendarService } from './game-calendar.service';

@Controller('games')
export class GameCalendarController {
  constructor(private readonly gameCalendarService: GameCalendarService) {}

  // 전체 조회
  @Get('/:yearMonth')
  async getAllGames(@Param('yearMonth') yearMonth: string) {
    const [yearStr, monthStr] = yearMonth.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr); // 1~12
    const res = await this.gameCalendarService.getGamesByYearMonth(year, month);
    console.log(res);
    return res;
  }
}
