import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { RawgModule } from './rawg/rawg.module';
import { YouTubeModule } from './youtube/youtube.module';
import { SteamModule } from './steam/steam.module';
import { UnifiedGameModule } from './unified-game/unified-game.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RawgModule,
    YouTubeModule,
    SteamModule,

    // ✅ 통합 모듈 (user_request.md 명세 구현 완료)
    UnifiedGameModule,
  ],
})
export class AppModule {}
