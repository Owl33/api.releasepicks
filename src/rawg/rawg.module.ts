import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RawgService } from './rawg.service';
import { RawgController } from './rawg.controller';
import { YouTubeModule } from '../youtube/youtube.module';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';

@Module({
  imports: [
    YouTubeModule,
    TypeOrmModule.forFeature([Game, GameDetail]),
  ],
  providers: [RawgService],
  controllers: [RawgController],
  exports: [RawgService],
})
export class RawgModule {}