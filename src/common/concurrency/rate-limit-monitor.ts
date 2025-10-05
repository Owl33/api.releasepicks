import { setTimeout as sleep } from 'timers/promises';

const RESET_WINDOW_MS = 5 * 60 * 1000; // 5분

interface RateLimitState {
  pausedUntil: number;
  strikes: number;
  lastStrikeAt: number;
}

class RateLimitMonitor {
  private readonly states = new Map<string, RateLimitState>();

  async waitIfPaused(key: string): Promise<void> {
    while (true) {
      const state = this.states.get(key);
      if (!state) return;

      const now = Date.now();
      if (state.pausedUntil <= now) return;

      const waitMs = state.pausedUntil - now;
      await sleep(waitMs);
    }
  }

  reportSuccess(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.strikes = 0;
    state.pausedUntil = 0;
  }

  report429(
    key: string,
    pauseMs: number,
    threshold = 3,
  ): { pauseMs: number; exceeded: boolean } {
    const now = Date.now();
    let state = this.states.get(key);
    if (!state) {
      state = { pausedUntil: 0, strikes: 0, lastStrikeAt: 0 };
      this.states.set(key, state);
    }

    if (now - state.lastStrikeAt > RESET_WINDOW_MS) {
      state.strikes = 0;
    }

    state.lastStrikeAt = now;
    state.strikes += 1;
    state.pausedUntil = Math.max(state.pausedUntil, now + pauseMs);

    return {
      pauseMs,
      exceeded: state.strikes >= threshold,
    };
  }
}

export class RateLimitExceededError extends Error {
  constructor(
    readonly key: string,
    message?: string,
  ) {
    super(message ?? `Rate limit exceeded for ${key}`);
    this.name = 'RateLimitExceededError';
  }
}

export const rateLimitMonitor = new RateLimitMonitor();
