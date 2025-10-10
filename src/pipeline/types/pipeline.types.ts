// ⚠️ Deprecated: Phase 2 이후에는 @pipeline/contracts 경로를 직접 사용하세요.
// 기존 코드 호환을 위해 타입을 재출력합니다.

export type {
  ProcessedGameData,
  CompanyData,
  GameDetailsData,
  GameReleaseData,
  SteamRefreshCandidate,
} from '@pipeline/contracts';

export type {
  ExistingGamesMap,
  PrioritySelectionOptions,
  SteamCollectOptions,
  CollectProcessedDataOptions,
} from '@pipeline/contracts';

export type { PipelineRunResult, ApiResponse } from '@pipeline/contracts';
