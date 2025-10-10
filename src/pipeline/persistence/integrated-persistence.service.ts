import { Injectable } from '@nestjs/common';

import { ProcessedGameData } from '@pipeline/contracts';

import { PersistenceOrchestratorService } from './persistence-orchestrator.service';
import { PersistenceSaveResult } from './persistence.types';

/**
 * IntegratedPersistenceService
 * - PipelineController가 의존할 Facade 레이어
 * - 현재는 오케스트레이터 호출만 담당하며, 추후 저장 로직 이관 시 세부 책임을 확장한다.
 */
@Injectable()
export class IntegratedPersistenceService {
  constructor(
    private readonly orchestrator: PersistenceOrchestratorService,
  ) {}

  async saveProcessedGames(
    payload: ProcessedGameData[],
    pipelineRunId: number,
  ): Promise<PersistenceSaveResult> {
    return this.orchestrator.saveBatch(payload, pipelineRunId);
  }
}
