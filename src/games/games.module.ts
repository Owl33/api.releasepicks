import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Game,
  GameRelease,
  Company,
  GameCompanyRole,
  GameDetail,
} from '../entities';
import { GamesService } from './games.service';
import { GamesController } from './games.controller';
import { GameSearchService } from './game-search.service';
/**
 * 프론트엔드 게임 API 모듈
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Game,
      GameRelease,
      GameDetail,
      Company,
      GameCompanyRole, // ✅ 반드시 포함
    ]),
  ],
  providers: [GamesService, GameSearchService],
  controllers: [GamesController],
})
export class GamesModule {}
