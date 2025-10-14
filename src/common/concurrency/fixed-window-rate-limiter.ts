import { setTimeout as sleep } from 'timers/promises';
import { Logger } from '@nestjs/common';

/**
 * 고정 윈도우 기반 Rate Limiter
 *
 * 핵심 기능:
 * 1. 지정된 윈도우(예: 5분) 동안 최대 호출 수(예: 200회) 제한
 * 2. 초과 시 자동으로 남은 시간 대기 후 새 윈도우 시작
 * 3. 큐 기반 직렬화로 병렬 요청도 안전하게 처리
 * 4. 최소 간격(minSpacingMs) 지원으로 버스트 방지
 */
export class FixedWindowRateLimiter {
  private readonly logger = new Logger(FixedWindowRateLimiter.name);
  private windowStart = 0;
  private count = 0;
  private queue: Promise<void> = Promise.resolve();
  private lastCallTime = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number,
    private readonly minSpacingMs: number = 0,
  ) {
    this.logger.log(
      `🔧 Rate Limiter 초기화: ${maxEvents}회/${(windowMs / 1000).toFixed(0)}초, 최소간격=${minSpacingMs}ms`,
    );
  }

  async take(): Promise<void> {
    this.queue = this.queue.then(() => this.consume());
    return this.queue;
  }

  private async consume(): Promise<void> {
    const now = Date.now();

    // 1) 최소 간격 대기 (버스트 방지)
    if (this.minSpacingMs > 0 && this.lastCallTime > 0) {
      const timeSinceLastCall = now - this.lastCallTime;
      const spacingWait = this.minSpacingMs - timeSinceLastCall;
      if (spacingWait > 0) {
        // this.logger.debug(
        //   `⏱️ Spacing 대기: ${spacingWait.toFixed(0)}ms (마지막 호출로부터 ${timeSinceLastCall.toFixed(0)}ms 경과)`,
        // );
        await sleep(spacingWait);
      }
    }

    // 2) 윈도우 만료 확인 및 리셋
    const currentTime = Date.now();
    if (currentTime >= this.windowStart + this.windowMs) {
      const windowAge =
        this.windowStart === 0
          ? 0
          : ((currentTime - this.windowStart) / 1000).toFixed(1);
      this.logger.log(
        `🔄 윈도우 리셋: 이전 윈도우 ${windowAge}초 경과, 이전 카운트=${this.count}/${this.maxEvents}`,
      );
      this.windowStart = currentTime;
      this.count = 0;
    }

    // 3) 카운트 체크 및 처리
    if (this.count < this.maxEvents) {
      this.count += 1;
      const windowElapsed = ((Date.now() - this.windowStart) / 1000).toFixed(1);
      // this.logger.debug(
      //   `✅ 요청 허용: [${this.count}/${this.maxEvents}] (윈도우 경과: ${windowElapsed}초)`,
      // );
      this.lastCallTime = Date.now();
      return;
    }

    // 4) 윈도우 초과 시 대기
    const waitMs = this.windowStart + this.windowMs - Date.now();
    if (waitMs > 0) {
      this.logger.warn(
        `🚫 Rate Limit 도달: [${this.count}/${this.maxEvents}] → ${(waitMs / 1000).toFixed(1)}초 대기 중...`,
      );
      await sleep(waitMs);
    }

    // 5) 새 윈도우 시작
    this.logger.log(`🔄 새 윈도우 시작: 카운트 리셋`);
    this.windowStart = Date.now();
    this.count = 1;
    this.lastCallTime = Date.now();
  }
}
