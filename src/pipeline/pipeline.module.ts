import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { PipelineController } from './pipeline.controller';

import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
import { GameRelease } from '../entities/game-release.entity';
import { PipelineRun } from '../entities/pipeline-run.entity';
import { PipelineItem } from '../entities/pipeline-item.entity';

import { SteamModule } from '../steam/steam.module';
import { RawgModule } from '../rawg/rawg.module';

/**
 * Pipeline Module
 * 데이터 파이프라인 통합 모듈
 * - Steam/RAWG 데이터 수집 서비스 의존성 주입
 * - 자동 스케줄링 (Cron)
 * - 수동 실행 API
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Game,
      GameDetail,
      GameRelease,
      PipelineRun,
      PipelineItem,
    ]),
    ScheduleModule.forRoot(), // Cron 스케줄링
    SteamModule, // Steam 데이터 수집 서비스
    RawgModule, // RAWG 데이터 수집 서비스
  ],
  controllers: [PipelineController],
  exports: [],
})
export class PipelineModule {}
