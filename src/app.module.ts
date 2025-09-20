import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { RawgModule } from './rawg/rawg.module';
import { GameCalendarModule } from './game-calendar/game-calendar.module';
import { YouTubeModule } from './youtube/youtube.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RawgModule,
    YouTubeModule,
    GameCalendarModule,
  ],
})
export class AppModule {}
