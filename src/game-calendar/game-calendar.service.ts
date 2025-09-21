import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';

@Injectable()
export class GameCalendarService {
  private readonly logger = new Logger(GameCalendarService.name);

  constructor(
    @InjectRepository(Game)
    private readonly gameRepository: Repository<Game>,
    @InjectRepository(GameDetail)
    private readonly gameDetailRepository: Repository<GameDetail>,
  ) {}

  async getAllGames() {
    return this.gameRepository.find({ take: 10 });
  }

  // 연도-월 조회
  async getGamesByYearMonth(year: number, month: number) {
    // month: 1~12 기준
    const start = new Date(year, month - 1, 1); // 해당 월 1일
    const end = new Date(year, month, 0, 23, 59, 59); // 해당 월 마지막 날

    return this.gameRepository.find({
      where: { released: Between(start, end) },
      order: { released: 'ASC' },
    });
  }
}
