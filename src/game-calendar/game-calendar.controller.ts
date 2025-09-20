import { Controller, Get, Param, Query } from '@nestjs/common';
import { GameCalendarService } from './game-calendar.service';

@Controller('games')
export class GameCalendarController {
  constructor(private readonly gameCalendarService: GameCalendarService) {}

  // 여기에 API 엔드포인트를 추가하세요
  // 예시:
  @Get('/')
  async getAllGames() {
    return this.gameCalendarService.getAllGames();
  }
}
