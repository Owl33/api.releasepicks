import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GameCalendarService } from './game-calendar.service';
import { GameCalendarController } from './game-calendar.controller';
import { RawgModule } from '../rawg/rawg.module';
import { YouTubeModule } from '../youtube/youtube.module';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Game, GameDetail]),
    RawgModule,
    YouTubeModule,
  ],
  providers: [GameCalendarService],
  controllers: [GameCalendarController],
  exports: [GameCalendarService],
})
export class GameCalendarModule {}