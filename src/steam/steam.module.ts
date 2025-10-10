import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SteamController } from './steam.controller';

// 엔티티
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
import { GameRelease } from '../entities/game-release.entity';
import { DataSyncStatus } from '../entities/data-sync-status.entity';
import { PipelineRun } from '../entities/pipeline-run.entity';
import { PipelineItem } from '../entities/pipeline-item.entity';
import { SystemEvent } from '../entities/system-event.entity';

// 서비스
import { SteamAppListService } from './services/steam-applist.service';
import { SteamAppDetailsService } from './services/steam-appdetails.service';
import { SteamCommunityService } from './services/steam-community.service';
import { SteamDataPipelineService } from './services/steam-data-pipeline.service';
import { SteamReviewService } from './services/steam-review.service';
// YouTube 모듈 (Phase 4)
import { YouTubeModule } from '../youtube/youtube.module';
import { PipelinePersistenceModule } from '../pipeline/persistence/pipeline-persistence.module';

/**
 * Steam API 모듈
 * FINAL-ARCHITECTURE-DESIGN Phase 1 파이프라인 구현
 *
 * 구성:
 * - SteamAppListService: AppList API (게임 목록)
 * - SteamAppDetailsService: AppDetails API (게임 상세정보)
 * - SteamCommunityService: Community 스크레이핑 (팔로워)
 * - SteamDataPipelineService: 통합 파이프라인 조합
 * - YouTubeService: 트레일러 검색 (Phase 4)
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 3,
    }),
    ConfigModule,
    YouTubeModule, // Phase 4: YouTube 서비스 사용
    TypeOrmModule.forFeature([
      Game,
      GameDetail,
      GameRelease,
      DataSyncStatus,
      PipelineRun,
      PipelineItem,
      SystemEvent,
    ]),
    PipelinePersistenceModule,
  ],
  providers: [
    SteamAppListService,
    SteamAppDetailsService,
    SteamCommunityService,
    SteamDataPipelineService,
    SteamReviewService,
  ],
  controllers: [SteamController],
  exports: [
    SteamAppListService,
    SteamAppDetailsService,
    SteamCommunityService,
    SteamDataPipelineService,
    SteamReviewService,
  ],
})
export class SteamModule {}
