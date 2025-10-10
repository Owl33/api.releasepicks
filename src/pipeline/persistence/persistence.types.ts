export interface PersistenceSaveResult {
  created: number;
  updated: number;
  failed: number;
}

export interface SaveMetricsSummary {
  totalItems: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  created: number;
  updated: number;
  failed: number;
  retries: Record<string, number>;
  failureReasons: { code: string; count: number }[];
  concurrency: number;
  maxAttempts: number;
}
