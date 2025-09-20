import { Module } from '@nestjs/common';
import { GameCalendarService } from './game-calendar.service';
import { GameCalendarController } from './game-calendar.controller';
import { RawgModule } from '../rawg/rawg.module';
import { YouTubeModule } from '../youtube/youtube.module';

@Module({
  imports: [RawgModule, YouTubeModule],
  providers: [GameCalendarService],
  controllers: [GameCalendarController],
  exports: [GameCalendarService],
})
export class GameCalendarModule {}