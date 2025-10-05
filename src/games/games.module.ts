import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Game, GameRelease } from '../entities';
import { GamesService } from './games.service';
import { GamesController } from './games.controller';

/**
 * 프론트엔드 게임 API 모듈
 */
@Module({
  imports: [TypeOrmModule.forFeature([Game, GameRelease])],
  providers: [GamesService],
  controllers: [GamesController],
})
export class GamesModule {}
