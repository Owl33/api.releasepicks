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
  };
  rawgReport?: any;
}

export interface ApiResponse<T> {
  statusCode: number;
  message: string;
  data?: T;
}
