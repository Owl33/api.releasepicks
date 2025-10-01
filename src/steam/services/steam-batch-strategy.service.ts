import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DataSyncStatus } from '../../entities';

/**
 * Steam 점진적 배치 수집 전략 서비스
 *
 * 목표: 15만개 게임을 안전하게 단계적으로 수집
 * 전략:
 * - 0-50: 50개 (테스트)
 * - 51-1,000: 1,000개 단위
 * - 1,001-5,000: 5,000개 단위
 * - 5,001-30,000: 5,000개 단위
 * - 30,001-150,000: 10,000개 단위
 */
@Injectable()
export class SteamBatchStrategyService {
  private readonly logger = new Logger(SteamBatchStrategyService.name);

  constructor(
    @InjectRepository(DataSyncStatus)
    private readonly dataSyncStatusRepository: Repository<DataSyncStatus>,
  ) {}

  /**
   * 다음 배치 정보 조회
   * @returns { startIndex, endIndex, batchSize, totalProcessed }
   */
  async getNextBatch(): Promise<{
    startIndex: number;
    endIndex: number;
    batchSize: number;
    totalProcessed: number;
    isComplete: boolean;
  }> {
    // 1. 현재 진행 상태 조회
    const syncStatus = await this.getSyncStatus();
    const totalProcessed = syncStatus?.totalProcessed ?? 0;

    // 2. 배치 크기 결정
    const batchSize = this.calculateBatchSize(totalProcessed);

    // 3. 시작/종료 인덱스 계산
    const startIndex = totalProcessed;
    const endIndex = Math.min(startIndex + batchSize, 150000);

    // 4. 완료 여부 확인
    const isComplete = totalProcessed >= 150000;

    this.logger.log(
      `📊 [Batch Strategy] 다음 배치: ${startIndex}-${endIndex} (${batchSize}개, 총 진행: ${totalProcessed}/150,000)`
    );

    return {
      startIndex,
      endIndex,
      batchSize,
      totalProcessed,
      isComplete,
    };
  }

  /**
   * 배치 크기 자동 계산
   * @param totalProcessed 현재까지 처리된 개수
   * @returns 다음 배치 크기
   */
  private calculateBatchSize(totalProcessed: number): number {
    if (totalProcessed < 50) {
      return 50; // 0-50: 테스트 (50개)
    } else if (totalProcessed < 1000) {
      return 1000 - totalProcessed; // 51-1,000: 나머지 전부
    } else if (totalProcessed < 5000) {
      return 5000 - totalProcessed; // 1,001-5,000: 나머지 전부
    } else if (totalProcessed < 30000) {
      return 5000; // 5,001-30,000: 5,000개 단위
    } else if (totalProcessed < 150000) {
      return 10000; // 30,001-150,000: 10,000개 단위
    } else {
      return 0; // 완료
    }
  }

  /**
   * 배치 완료 후 진행 상태 업데이트
   * @param processedCount 이번 배치에서 처리된 개수
   */
  async updateBatchProgress(processedCount: number): Promise<void> {
    const syncStatus = await this.getSyncStatus();
    const currentTotal = syncStatus?.totalProcessed ?? 0;
    const newTotal = currentTotal + processedCount;

    const syncData = {
      totalProcessed: newTotal,
      lastBatchSize: processedCount,
      lastBatchAt: new Date().toISOString(),
      batchVersion: 1,
    };

    await this.dataSyncStatusRepository.upsert(
      {
        sync_name: 'steam_batch_progress',
        sync_data: syncData as any,
      },
      ['sync_name']
    );

    this.logger.log(
      `✅ [Batch Strategy] 진행 상태 업데이트: ${newTotal}/150,000 (${((newTotal / 150000) * 100).toFixed(1)}%)`
    );
  }

  /**
   * 진행 상태 초기화 (재시작 시)
   */
  async resetProgress(): Promise<void> {
    await this.dataSyncStatusRepository.delete({ sync_name: 'steam_batch_progress' });
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
    const totalTarget = 150000;
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
