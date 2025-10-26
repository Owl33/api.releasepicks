import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { SteamModule } from './steam/steam.module';
import { RawgModule } from './rawg/rawg.module';
import { YouTubeModule } from './youtube/youtube.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { GamesModule } from './games/games.module';
// import { UnifiedGameModule } from './unified-game/unified-game.module';
// import { SteamCommunityModule } from './steam-community/steamcommunity.module';
// 🛡️ 통합 에러 처리 시스템
// import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
// import { ResponseInterceptor } from './common/interceptors/response.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(), // ✅ Cron 작업 스케줄링
    DatabaseModule, // ✅ 9개 테이블 구조 + 직관적 네이밍
    SteamModule, // ✅ Steam API 통합 파이프라인 (Phase 1)
    RawgModule, // ✅ RAWG API 연동 파이프라인 (Phase 2)
    PipelineModule, // ✅ 통합 Pipeline Controller (Phase 3)
    YouTubeModule,
    GamesModule, // ✅ 프론트엔드 제공 REST API
    // ✅ 통합 모듈 (user_request.md 명세 구현 완료)
    // UnifiedGameModule,
    // SteamCommunityModule,
  ],
  // providers: [
  //   // 🛡️ 전역 Exception Filter 등록
  //   {
  //     provide: APP_FILTER,
  //     useClass: GlobalExceptionFilter,
  //   },
  //   // 🎯 전역 Response Interceptor 등록
  //   {
  //     provide: APP_INTERCEPTOR,
  //     useClass: ResponseInterceptor,
  //   },
  // ],
})
export class AppModule {}
