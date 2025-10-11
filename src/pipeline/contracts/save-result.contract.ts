import { ProcessedGameData } from './processed-game-data.contract';

export type SaveFailureReason =
  | 'STEAM_APP_NOT_FOUND'
  | 'RAWG_GAME_NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'DUPLICATE_CONSTRAINT'
  | 'RATE_LIMIT'
  | 'UNKNOWN';

export interface SaveFailureDetail {
  data: ProcessedGameData;
  reason: SaveFailureReason;
  message: string;
}

export interface PersistenceSaveResult {
  created: number;
  updated: number;
  failed: number;
  failures: SaveFailureDetail[];
}
