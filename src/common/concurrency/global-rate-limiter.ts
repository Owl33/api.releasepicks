import { setTimeout as sleep } from 'timers/promises';

export interface RateLimiterOptions {
  capacity: number;
  refillPerSecond: number;
  minDelayMs: number;
  jitterMs: number;
}

class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly baseRefillPerSecond: number;
  private refillPerSecond: number;
  private lastRefill = Date.now();
  private slowUntil = 0;

  constructor(private readonly options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.baseRefillPerSecond = options.refillPerSecond;
    this.refillPerSecond = options.refillPerSecond;
    this.tokens = options.capacity;
  }

  private refillNow(): void {
    const now = Date.now();
    if (now <= this.lastRefill) return;
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.refillPerSecond,
    );
    this.lastRefill = now;
    if (this.slowUntil && now >= this.slowUntil) {
      this.refillPerSecond = this.baseRefillPerSecond;
      this.slowUntil = 0;
    }
  }

  async take(amount = 1, minDelayMs = 0, jitterMs = 0): Promise<void> {
    if (minDelayMs > 0) {
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      await sleep(minDelayMs + jitter);
    }

    while (true) {
      this.refillNow();
      if (this.tokens >= amount) {
        this.tokens -= amount;
        return;
      }
      const deficit = amount - this.tokens;
      const waitSec = deficit / this.refillPerSecond;
      await sleep(Math.ceil(waitSec * 1000));
    }
  }

  backoff(factor: number, durationMs: number): void {
    const now = Date.now();
    this.slowUntil = Math.max(this.slowUntil, now + durationMs);
    const newRate = this.baseRefillPerSecond * Math.max(factor, 0.05);
    this.refillPerSecond = Math.max(0.05, newRate);
  }
}

class GlobalRateLimiter {
  private readonly bucket: TokenBucket;

  constructor(private readonly options: RateLimiterOptions) {
    this.bucket = new TokenBucket(options);
  }

  async take(
    key: string,
    opts: { amount?: number; minDelayMs?: number; jitterMs?: number } = {},
  ): Promise<void> {
    const amount = opts.amount ?? 1;
    const minDelayMs = opts.minDelayMs ?? this.options.minDelayMs;
    const jitterMs = opts.jitterMs ?? this.options.jitterMs;
    await this.bucket.take(amount, minDelayMs, jitterMs);
  }

  backoff(key: string, factor: number, durationMs: number): void {
    this.bucket.backoff(factor, durationMs);
  }
}

let sharedLimiter: GlobalRateLimiter | null = null;

function resolveOptions(): RateLimiterOptions {
  const capacity = Number(process.env.STEAM_GLOBAL_BURST ?? '10');
  const refillPerSecond = Number(process.env.STEAM_GLOBAL_RPS ?? '6');
  const minDelayMs = Number(process.env.STEAM_GLOBAL_MIN_DELAY_MS ?? '80');
  const jitterMs = Number(process.env.STEAM_GLOBAL_JITTER_MS ?? '50');
  return {
    capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : 10,
    refillPerSecond:
      Number.isFinite(refillPerSecond) && refillPerSecond > 0
        ? refillPerSecond
        : 6,
    minDelayMs: Number.isFinite(minDelayMs) && minDelayMs >= 0 ? minDelayMs : 80,
    jitterMs: Number.isFinite(jitterMs) && jitterMs >= 0 ? jitterMs : 50,
  };
}

export function configureGlobalRateLimiter(
  override?: Partial<RateLimiterOptions>,
): GlobalRateLimiter {
  const base = resolveOptions();
  const options: RateLimiterOptions = {
    capacity: override?.capacity ?? base.capacity,
    refillPerSecond: override?.refillPerSecond ?? base.refillPerSecond,
    minDelayMs: override?.minDelayMs ?? base.minDelayMs,
    jitterMs: override?.jitterMs ?? base.jitterMs,
  };
  sharedLimiter = new GlobalRateLimiter(options);
  return sharedLimiter;
}

export function getGlobalRateLimiter(): GlobalRateLimiter {
  if (!sharedLimiter) {
    sharedLimiter = new GlobalRateLimiter(resolveOptions());
  }
  return sharedLimiter;
}
