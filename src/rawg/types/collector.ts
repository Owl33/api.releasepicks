import { RawgMonitorSnapshot } from '../utils/rawg-monitor';
import { CollectProcessedDataOptions } from '@pipeline/contracts';
import { Store } from '../../entities/enums';

export type ConsoleFamily = 'pc' | 'playstation' | 'xbox' | 'nintendo';

export interface RawgPlatformInfo {
  slug?: string;
  releasedAt?: string | null;
}

export interface RawgIntermediate {
  rawgId: number;
  slug: string;
  name: string;
  headerImage: string;
  screenshots: string[];
  released: string | null;
  platformFamilies: ConsoleFamily[];
  platformDetails: RawgPlatformInfo[];
  added: number;
  popularityScore: number;
  isDlc: boolean;
  parentRawgId?: number;
  sourceMonth: string;
}

export interface RawgMonthStat {
  month: string;
  attempt: number;
  requestCount: number;
  gameCount: number;
  durationMs: number;
  success: boolean;
  reason?: string;
}

export interface RawgRetryLog {
  month: string;
  attempts: number;
  status: 'requeued' | 'failed';
  reason?: string;
}

export interface RawgCollectionReport {
  startedAt: string;
  finishedAt: string;
  totalGames: number;
  months: RawgMonthStat[];
  failedMonths: string[];
  retryLogs: RawgRetryLog[];
  consoleIssues: string[];
  monitorSnapshot: RawgMonitorSnapshot;
}

export interface StoreInfo {
  store: Store;
  storeAppId: string;
  storeUrl: string | null;
  family: ConsoleFamily;
}

export type RawgCollectorOptions = CollectProcessedDataOptions;
