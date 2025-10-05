import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RawgApiService } from './rawg-api.service';
import { RawgDataPipelineService } from './rawg-data-pipeline.service';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
import { GameRelease } from '../entities/game-release.entity';
import { SystemEvent } from '../entities/system-event.entity';

// YouTube 모듈 (Phase 4)
import { YouTubeModule } from '../youtube/youtube.module';

/**
 * RAWG API 연동 모듈
 *
 * 제공 기능:
 * - RAWG API 호출 서비스
 * - Steam ↔ RAWG 게임 매칭 서비스
 * - RAWG 데이터 파이프라인 (매주 수요일 실행)
 * - 콘솔 플랫폼 정보 수집 및 통합
 * - YouTubeService: 트레일러 검색 (Phase 4)
 */
@Module({
  imports: [
    // HTTP 모듈 (RAWG API 호출용)
    HttpModule.register({
      timeout: 10000, // 10초 타임아웃
    }),

    // YouTube 모듈 (Phase 4: 트레일러 검색)
    YouTubeModule,

    // TypeORM 엔티티 등록
    TypeOrmModule.forFeature([Game, GameDetail, GameRelease, SystemEvent]),
  ],
  providers: [RawgApiService, RawgDataPipelineService],
  exports: [RawgApiService, RawgDataPipelineService],
})
export class RawgModule {}
