import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Game } from '../../entities/game.entity';
import { GameDetail } from '../../entities/game-detail.entity';
import { GameRelease } from '../../entities/game-release.entity';
import { Company } from '../../entities/company.entity';
import { GameCompanyRole } from '../../entities/game-company-role.entity';
import { PipelineRun } from '../../entities/pipeline-run.entity';
import { PipelineItem } from '../../entities/pipeline-item.entity';
import { PersistenceOrchestratorService } from './persistence-orchestrator.service';
import { IntegratedPersistenceService } from './integrated-persistence.service';
import { GamePersistenceService } from './services/game-persistence.service';
import { ReleasePersistenceService } from './services/release-persistence.service';
import { CompanyRegistryService } from './services/company-registry.service';
import { SLUG_POLICY } from './slug/slug-policy.interface';
import { SlugPolicyService } from './slug/slug-policy.service';
import { ExistingGamesSnapshotService } from './services/existing-games-snapshot.service';
import { MultiPlatformMatchingService } from './services/multi-platform-matching.service';

/**
 * PipelinePersistenceModule
 * - Phase 3 Persistence 계층 1차 스켈레톤
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Game,
      GameDetail,
      GameRelease,
      Company,
      GameCompanyRole,
      PipelineRun,
      PipelineItem,
    ]),
  ],
  providers: [
    IntegratedPersistenceService,
    PersistenceOrchestratorService,
    GamePersistenceService,
    ReleasePersistenceService,
    CompanyRegistryService,
    SlugPolicyService,
    ExistingGamesSnapshotService,
    MultiPlatformMatchingService,
    {
      provide: SLUG_POLICY,
      useExisting: SlugPolicyService,
    },
  ],
  exports: [
    IntegratedPersistenceService,
    SlugPolicyService,
    ExistingGamesSnapshotService,
  ],
})
export class PipelinePersistenceModule {}
