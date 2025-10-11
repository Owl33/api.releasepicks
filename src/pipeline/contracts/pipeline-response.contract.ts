import { SteamRefreshCandidate } from './processed-game-data.contract';

export interface PipelineRunResult {
  pipelineRunId: number;
  phase: 'steam' | 'rawg' | 'full';
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
}

export interface ApiResponse<T> {
  statusCode: number;
  message: string;
  data?: T;
}
