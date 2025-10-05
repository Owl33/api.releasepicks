type RawgErrorLevel = 'warn' | 'error';

interface RawgRequestMetric {
  endpoint: string;
  status: number;
  durationMs: number;
  payloadBytes: number;
  timestamp: number;
}

interface RawgErrorMetric extends RawgRequestMetric {
  attempt: number;
  level: RawgErrorLevel;
}

export interface RawgMonitorSnapshot {
  windowMs: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  rateLimitCount: number;
  serverErrorCount: number;
  averageDurationMs: number;
  averagePayloadBytes: number;
  recentErrors: RawgErrorMetric[];
}

/**
 * RAWG API 요청 메트릭을 수집하는 경량 모니터
 * - 메모리에 최근 N분 간의 요청 데이터를 유지한다.
 * - 429/5xx 비율을 계산해 알람 기준으로 활용한다.
 */
export class RawgMonitor {
  private readonly windowMs: number;
  private readonly requests: RawgRequestMetric[] = [];
  private readonly errors: RawgErrorMetric[] = [];

  constructor(windowMinutes = 15) {
    this.windowMs = windowMinutes * 60 * 1000;
  }

  recordSuccess(metric: RawgRequestMetric): void {
    this.requests.push(metric);
    this.trim();
  }

  recordError(metric: RawgErrorMetric): void {
    this.requests.push(metric);
    this.errors.push(metric);
    this.trim();
  }

  snapshot(): RawgMonitorSnapshot {
    this.trim();
    const now = Date.now();
    const recentRequests = this.requests.filter(
      (r) => now - r.timestamp <= this.windowMs,
    );
    const recentErrors = this.errors.filter(
      (r) => now - r.timestamp <= this.windowMs,
    );

    const successCount = recentRequests.filter((r) => r.status < 400).length;
    const errorCount = recentRequests.length - successCount;
    const rateLimitCount = recentErrors.filter((r) => r.status === 429).length;
    const serverErrorCount = recentErrors.filter((r) => r.status >= 500).length;

    const avgDuration = recentRequests.length
      ? Math.round(
          recentRequests.reduce((sum, r) => sum + r.durationMs, 0) /
            recentRequests.length,
        )
      : 0;
    const avgPayload = recentRequests.length
      ? Math.round(
          recentRequests.reduce((sum, r) => sum + r.payloadBytes, 0) /
            recentRequests.length,
        )
      : 0;

    return {
      windowMs: this.windowMs,
      requestCount: recentRequests.length,
      successCount,
      errorCount,
      rateLimitCount,
      serverErrorCount,
      averageDurationMs: avgDuration,
      averagePayloadBytes: avgPayload,
      recentErrors,
    };
  }

  private trim(): void {
    const threshold = Date.now() - this.windowMs;
    while (this.requests.length && this.requests[0].timestamp < threshold) {
      this.requests.shift();
    }
    while (this.errors.length && this.errors[0].timestamp < threshold) {
      this.errors.shift();
    }
  }
}

export const rawgMonitor = new RawgMonitor();
