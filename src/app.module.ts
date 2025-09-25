import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { RawgModule } from './rawg/rawg.module';
import { YouTubeModule } from './youtube/youtube.module';
import { SteamModule } from './steam/steam.module';
import { UnifiedGameModule } from './unified-game/unified-game.module';

// 🛡️ 통합 에러 처리 시스템
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

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
  providers: [
    // 🛡️ 전역 Exception Filter 등록
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // 🎯 전역 Response Interceptor 등록
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class AppModule {}
