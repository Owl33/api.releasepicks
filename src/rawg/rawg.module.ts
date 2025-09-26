import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RawgService } from './rawg.service';
import { RawgController } from './rawg.controller';
import { YouTubeModule } from '../youtube/youtube.module';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
import { RawgCollector } from './rawg.collector';

@Module({
  imports: [YouTubeModule, TypeOrmModule.forFeature([Game, GameDetail])],
  providers: [RawgService, RawgCollector],
  controllers: [RawgController],
  exports: [RawgService, RawgCollector],
})
export class RawgModule {}
