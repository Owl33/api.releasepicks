import { SteamRefreshCandidate } from './processed-game-data.contract';

export interface PipelineRunResult {
  pipelineRunId: number;
  phase: 'steam' | 'rawg' | 'full' | 'rawg-new' | 'rawg-refresh';
  totalProcessed: number;
  finishedAt: Date;
  refreshSummary?: {
    totalCandidates: number;
    processed: number;
    saved: number;
    failed: number;
    dryRun: boolean;
    candidates: SteamRefreshCandidate[];
    failures?: {
      steamId: number | null;
      rawgId: number | null;
      slug: string | null;
      reason: string;
      message: string;
    }[];
  };
  steamNewSummary?: {
    candidates: number;
    inspected: number;
    targetIds: number[];
    excludedByRegistry?: number;
    created: number;
    updated: number;
    saved: number;
    failed: number;
    dryRun: boolean;
    sample?: number[];
    failures?: {
      steamId: number | null;
      rawgId: number | null;
      slug: string | null;
      reason: string;
      message: string;
    }[];
  };
  steamSummary?: {
    created: number;
    updated: number;
    failed: number;
    excludedByRegistry?: number;
    total: number;
    failures?: {
      steamId?: number | null;
      rawgId?: number | null;
      slug?: string | null;
      reason: string;
      message: string;
    }[];
  };
  rawgReport?: any;
  rawgNewSummary?: {
    collected: number;
    saved: number;
    created: number;
    updated: number;
    failed: number;
    dryRun: boolean;
    excludeExisting: boolean;
    monthsBack: number | null;
    monthsForward: number | null;
    startMonth: string | null;
    endMonth: string | null;
    pageSize: number | null;
    months?: string[];
    failures?: {
      steamId: number | null;
      rawgId: number | null;
      slug: string | null;
      reason: string;
      message: string;
    }[];
  };
  rawgRefreshSummary?: {
    targetIds: number[];
    inspected: number;
    processed: number;
    saved: number;
    failed: number;
    dryRun: boolean;
    chunkSize: number | null;
    delayMs: number | null;
    failures?: {
      steamId: number | null;
      rawgId: number | null;
      slug: string | null;
      reason: string;
      message: string;
    }[];
  };
  fullRefreshSummary?: {
    totalGames: number;
    processedGames: number;
    steamRequested: number;
    collected: number;
    updated: number;
    failed: number;
    dryRun: boolean;
    target?: 'all' | 'zero-popularity';
    failures?: {
      steamId: number | null;
      rawgId: number | null;
      slug: string | null;
      reason: string;
      message: string;
    }[];
  };
}

export interface ApiResponse<T> {
  statusCode: number;
  message: string;
  data?: T;
}
