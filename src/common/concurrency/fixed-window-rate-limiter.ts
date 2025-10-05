import { setTimeout as sleep } from 'timers/promises';

/**
 * 고정 윈도우 기반 Rate Limiter
 * 지정된 윈도우 동안 허용된 호출 수를 초과하면 남은 시간을 대기한 뒤
 * 새 윈도우를 열고 카운터를 초기화합니다.
 */
export class FixedWindowRateLimiter {
  private windowStart = 0;
  private count = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number,
  ) {}

  async take(): Promise<void> {
    this.queue = this.queue.then(() => this.consume());
    return this.queue;
  }

  private async consume(): Promise<void> {
    const now = Date.now();
    if (now >= this.windowStart + this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }

    if (this.count < this.maxEvents) {
      this.count += 1;
      return;
    }

    const waitMs = this.windowStart + this.windowMs - now;
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    this.windowStart = Date.now();
    this.count = 1;
  }
}
