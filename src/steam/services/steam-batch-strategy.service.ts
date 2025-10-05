import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DataSyncStatus } from '../../entities';

/**
 * Steam 점진적 배치 수집 전략 서비스
 */
@Injectable()
export class SteamBatchStrategyService {
  private readonly logger = new Logger(SteamBatchStrategyService.name);
  private readonly DEFAULT_TARGET = 150_000;
  private totalTarget = this.DEFAULT_TARGET;

  constructor(
    @InjectRepository(DataSyncStatus)
    private readonly dataSyncStatusRepository: Repository<DataSyncStatus>,
  ) {}

  async getNextBatch(
    totalApps: number,
    overrideBatchSize?: number,
  ): Promise<{
    startIndex: number;
    endIndex: number;
    batchSize: number;
    totalProcessed: number;
    isComplete: boolean;
    totalTarget: number;
  }> {
    const normalizedTotal = Math.max(totalApps, 0);
    this.totalTarget = normalizedTotal > 0 ? normalizedTotal : this.DEFAULT_TARGET;

    const progress = await this.getSyncStatus();
    const rawProcessed = progress?.totalProcessed ?? 0;
    const totalProcessed = Math.min(rawProcessed, this.totalTarget);

    if (totalProcessed >= this.totalTarget) {
      this.logger.log(
        `📊 [Batch Strategy] 모든 AppList(${this.totalTarget}) 처리 완료`,
      );
      return {
        startIndex: this.totalTarget,
        endIndex: this.totalTarget,
        batchSize: 0,
        totalProcessed,
        isComplete: true,
        totalTarget: this.totalTarget,
      };
    }

    const remaining = this.totalTarget - totalProcessed;

    const batchSize = overrideBatchSize && overrideBatchSize > 0
      ? Math.min(overrideBatchSize, remaining)
      : remaining;

    const startIndex = totalProcessed;
    const endIndex = startIndex + batchSize;

    this.logger.log(
      `📊 [Batch Strategy] 다음 배치: [${startIndex}, ${endIndex}) = ${batchSize}개 (총 진행: ${totalProcessed}/${this.totalTarget})`,
    );

    return {
      startIndex,
      endIndex,
      batchSize,
      totalProcessed,
      isComplete: false,
      totalTarget: this.totalTarget,
    };
  }

  /**
   * 배치 완료 후 진행 상태 업데이트
   * @param processedCount 이번 배치에서 처리된 개수
   */
  async updateBatchProgress(processedCount: number): Promise<void> {
    const inc = Math.max(0, Math.floor(Number(processedCount) || 0));
    if (inc === 0) {
      this.logger.debug(`  ↪️ [Batch Strategy] attempted=0 → cursor 유지`);
      return;
    }

    // 현재 진행상태 읽기
    const syncStatus = await this.getSyncStatus();
    const prevTotal = Number(syncStatus?.totalProcessed) || 0;
    const target = this.totalTarget || this.DEFAULT_TARGET;
    const nextTotal = Math.min(prevTotal + inc, target);

    // DB에 누적 커서 저장
    const syncData = {
      totalProcessed: nextTotal, // ← 커서(누적 시도 수)
      lastBatchSize: inc, // 이번에 소비한 입력 수(=attempted)
      lastBatchAt: new Date().toISOString(), // 최근 배치 시각
      batchVersion: 1,
      totalTarget: target,
    };

    await this.dataSyncStatusRepository.upsert(
      {
        sync_name: 'steam_batch_progress',
        sync_data: syncData as any,
      },
      ['sync_name'],
    );
    this.logger.log(
      `✅ [Batch Strategy] 진행 상태 업데이트: ${nextTotal}/${target.toLocaleString()} (+${inc}, ${((nextTotal / target) * 100).toFixed(1)}%)`,
    );
  }

  /**
   * 진행 상태 초기화 (재시작 시)
   */
  async resetProgress(): Promise<void> {
    await this.dataSyncStatusRepository.delete({
      sync_name: 'steam_batch_progress',
    });
    this.logger.warn('🔄 [Batch Strategy] 진행 상태 초기화 완료');
  }

  /**
   * 현재 진행 상태 조회
   */
  private async getSyncStatus(): Promise<{
    totalProcessed: number;
    lastBatchSize: number;
    lastBatchAt: string;
    batchVersion: number;
    totalTarget: number;
  } | null> {
    const row = await this.dataSyncStatusRepository.findOne({
      where: { sync_name: 'steam_batch_progress' },
    });

    if (!row || !row.sync_data) return null;

    const data = row.sync_data;
    return {
      totalProcessed: data.totalProcessed ?? 0,
      lastBatchSize: data.lastBatchSize ?? 0,
      lastBatchAt: data.lastBatchAt ?? new Date(0).toISOString(),
      batchVersion: data.batchVersion ?? 1,
      totalTarget: data.totalTarget ?? this.totalTarget ?? this.DEFAULT_TARGET,
    };
  }

  /**
   * 진행 상황 통계 조회
   */
  async getProgressStats(): Promise<{
    totalProcessed: number;
    totalTarget: number;
    percentage: number;
    estimatedRemaining: string;
    currentStage: string;
  }> {
    const syncStatus = await this.getSyncStatus();
    const totalProcessed = syncStatus?.totalProcessed ?? 0;
    const totalTarget = this.totalTarget ?? syncStatus?.totalTarget ?? this.DEFAULT_TARGET;
    const percentage = (totalProcessed / totalTarget) * 100;

    // 현재 단계 판별
    let currentStage = '';
    if (totalProcessed < 50) {
      currentStage = '테스트 단계 (0-50)';
    } else if (totalProcessed < 1000) {
      currentStage = '초기 단계 (51-1,000)';
    } else if (totalProcessed < 5000) {
      currentStage = '검증 단계 (1,001-5,000)';
    } else if (totalProcessed < 30000) {
      currentStage = '중급 단계 (5,001-30,000)';
    } else if (totalProcessed < 150000) {
      currentStage = '고급 단계 (30,001-150,000)';
    } else {
      currentStage = '완료';
    }

    // 남은 개수 추정
    const remaining = totalTarget - totalProcessed;
    const estimatedRemaining = `약 ${remaining.toLocaleString()}개 남음`;

    return {
      totalProcessed,
      totalTarget,
      percentage: Math.round(percentage * 10) / 10,
      estimatedRemaining,
      currentStage,
    };
  }
}
