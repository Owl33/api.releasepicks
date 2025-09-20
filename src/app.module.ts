import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
// import { DatabaseModule } from './database/database.module'; // 임시 비활성화
import { RawgModule } from './rawg/rawg.module';
import { GameCalendarModule } from './game-calendar/game-calendar.module';
import { YouTubeModule } from './youtube/youtube.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // DatabaseModule, // 임시 비활성화 - Phase 2에서 PostgreSQL 설정 후 활성화
    RawgModule,
    YouTubeModule,
    GameCalendarModule,
  ],
})
export class AppModule {}
