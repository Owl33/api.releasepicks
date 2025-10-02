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
  async getNextBatch(
    limit?: number, // ⬅️ 추가 (선택 인자)
  ): Promise<{
    startIndex: number;
    endIndex: number;
    batchSize: number;
    totalProcessed: number;
    isComplete: boolean;
  }> {
    // 1. 진행 상태 조회 (기존 메서드 그대로 사용)
    const progress = await this.getSyncStatus();
    const totalProcessed = progress?.totalProcessed ?? 0;

    // 2. 배치 크기 결정 (limit 우선, 없으면 기존 자동 계산)
    const batchSize =
      limit && limit > 0 ? limit : this.calculateBatchSize(totalProcessed);

    // 3. 시작/종료 인덱스 + 실제 슬라이스 개수 계산
    const startIndex = totalProcessed;
    const endIndex = Math.min(startIndex + batchSize, 150000);
    const sliceCount = Math.max(0, endIndex - startIndex); // ← 로그에 이 값 사용

    // 4. 완료 여부 확인
    const isComplete = totalProcessed >= 150000;

    // 5. 로그: 괄호 안은 batchSize가 아니라 실제 슬라이스 개수로
    this.logger.log(
      `📊 [Batch Strategy] 다음 배치: [${startIndex}, ${endIndex}) = ${sliceCount}개 (총 진행: ${totalProcessed}/150,000)`,
    );

    return {
      startIndex,
      endIndex,
      batchSize, // 반환 타입은 기존 그대로 유지
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
    const inc = Math.max(0, Math.floor(Number(processedCount) || 0));
    if (inc === 0) {
      this.logger.debug(`  ↪️ [Batch Strategy] attempted=0 → cursor 유지`);
      return;
    }

    // 현재 진행상태 읽기
    const syncStatus = await this.getSyncStatus();
    const prevTotal = Number(syncStatus?.totalProcessed) || 0;
    const nextTotal = prevTotal + inc;

    // DB에 누적 커서 저장
    const syncData = {
      totalProcessed: nextTotal, // ← 커서(누적 시도 수)
      lastBatchSize: inc, // 이번에 소비한 입력 수(=attempted)
      lastBatchAt: new Date().toISOString(), // 최근 배치 시각
      batchVersion: 1,
    };

    await this.dataSyncStatusRepository.upsert(
      {
        sync_name: 'steam_batch_progress',
        sync_data: syncData as any,
      },
      ['sync_name'],
    );
    const TOTAL_TARGET = 150_000;

    this.logger.log(
      `✅ [Batch Strategy] 진행 상태 업데이트: ${nextTotal}/${TOTAL_TARGET.toLocaleString()} (+${inc}, ${((nextTotal / TOTAL_TARGET) * 100).toFixed(1)}%)`,
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
