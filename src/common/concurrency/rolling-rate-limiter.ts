import { setTimeout as sleep } from 'timers/promises';

export class RollingRateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly maxEvents: number, private readonly windowMs: number) {}

  async take(): Promise<void> {
    const now = Date.now();
    this.timestamps.push(now);
    this.cleanup(now);

    if (this.timestamps.length <= this.maxEvents) {
      return;
    }

    const oldestAllowed = this.timestamps[this.timestamps.length - this.maxEvents - 1];
    const delay = oldestAllowed + this.windowMs - now;
    if (delay > 0) {
      await sleep(delay);
    }
  }

  private cleanup(now: number): void {
    const threshold = now - this.windowMs;
    while (this.timestamps.length && this.timestamps[0] < threshold) {
      this.timestamps.shift();
    }
  }
}
