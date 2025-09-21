import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';

/**
 * GameCalendarService
 *
 * TypeORM을 사용한 게임 캘린더 서비스
 *
 * 역할:
 * - DB에서 게임 캘린더 데이터 조회
 * - 게임 정보 제공
 * - Repository 패턴 사용
 */
@Injectable()
export class GameCalendarService {
  private readonly logger = new Logger(GameCalendarService.name);

  constructor(
    @InjectRepository(Game)
    private readonly gameRepository: Repository<Game>,
    @InjectRepository(GameDetail)
    private readonly gameDetailRepository: Repository<GameDetail>,
  ) {}

  // 여기에 코드를 추가하세요
  // 예시:
  async getAllGames() {
    return this.gameRepository.find({
      take: 10,
    });
  }
}
