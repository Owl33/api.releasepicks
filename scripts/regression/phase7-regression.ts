import { promises as fs } from 'fs';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { QueryFailedError } from 'typeorm';

import { PipelineController } from '../../src/pipeline/pipeline.controller';
import { ProcessedGameData } from '../../src/pipeline/types/pipeline.types';
import {
  GameType,
  ReleaseStatus,
  Platform,
  Store,
  CompanyRole,
} from '../../src/entities/enums';

interface RegressionResult {
  totalCases: number;
  controllerResult: { created: number; updated: number; failed: number };
  metrics?: any;
  estimatedSecondsFor10k?: number;
}

const TRANSIENT_SLUGS = new Set<string>();
const PERMANENT_SLUGS = new Set<string>();
const EXISTING_SLUGS = new Set<string>();

function prepareScenario(slugCount: number): ProcessedGameData[] {
  TRANSIENT_SLUGS.clear();
  PERMANENT_SLUGS.clear();
  EXISTING_SLUGS.clear();

  const fixtures: ProcessedGameData[] = [];

  for (let i = 0; i < slugCount; i++) {
    const slug = `game-${i}`;
    const name = `Game ${i}`;
    const steamId = 1000 + i;

    if (i % 10 === 3) {
      TRANSIENT_SLUGS.add(slug);
    }
    if (i % 25 === 7) {
      PERMANENT_SLUGS.add(slug);
    }
    if (i % 2 === 0) {
      EXISTING_SLUGS.add(slug);
    }

    fixtures.push({
      name,
      slug,
      steamId,
      gameType: GameType.GAME,
      parentSteamId: undefined,
      parentRawgId: undefined,
      releaseDate: new Date('2024-01-01T00:00:00.000Z'),
      releaseDateRaw: '2024-01-01',
      releaseStatus: ReleaseStatus.RELEASED,
      comingSoon: false,
      popularityScore: 50,
      followersCache: 1500,
      companies: [
        { name: 'Studio A', role: CompanyRole.DEVELOPER },
        { name: 'Publisher B', role: CompanyRole.PUBLISHER },
      ],
      releases: [
        {
          platform: Platform.PC,
          store: Store.STEAM,
          storeAppId: String(steamId),
          storeUrl: `https://store.steampowered.com/app/${steamId}`,
          releaseDateDate: new Date('2024-01-01T00:00:00.000Z'),
          releaseDateRaw: '2024-01-01',
          releaseStatus: ReleaseStatus.RELEASED,
          comingSoon: false,
          isFree: false,
          dataSource: 'steam',
        },
      ],
    });
  }

  return fixtures;
}

async function runRegression(fixtures: ProcessedGameData[]): Promise<RegressionResult> {
  const pipelineRunsRepository = {
    lastSummary: undefined as string | undefined,
    async update(_: number, payload: any) {
      if (payload.summary_message) {
        this.lastSummary = payload.summary_message;
      }
    },
  };

  const dataSource = {
    async transaction<T>(fn: (manager: any) => Promise<T>): Promise<T> {
      return fn({});
    },
  };

  const controller = new PipelineController(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    pipelineRunsRepository as any,
    {} as any,
    dataSource as any,
  );

  const attemptsBySlug = new Map<string, number>();
  let generatedId = 1;

  (controller as any).findExistingGame = async (gameData: ProcessedGameData) => {
    const slug = gameData.slug;
    const attempt = (attemptsBySlug.get(slug) ?? 0) + 1;
    attemptsBySlug.set(slug, attempt);

    if (PERMANENT_SLUGS.has(slug)) {
      const error = new QueryFailedError('insert', [], { code: '23505' } as any);
      (error as any).message = 'duplicate key value violates unique constraint';
      throw error;
    }

    if (TRANSIENT_SLUGS.has(slug) && attempt === 1) {
      const error = new QueryFailedError('update', [], { code: '40001' } as any);
      (error as any).message = 'deadlock detected';
      throw error;
    }

    if (EXISTING_SLUGS.has(slug)) {
      return { id: slug.length };
    }

    return null;
  };

  (controller as any).updateGame = async () => {
    await delay(2);
  };

  (controller as any).createGame = async () => {
    await delay(2);
    return { id: generatedId++ };
  };

  (controller as any).createPipelineItem = async () => {
    await delay(1);
  };

  const result = await (controller as any).saveIntegratedData(fixtures, 42);

  let metrics: any;
  if (pipelineRunsRepository.lastSummary) {
    try {
      const parsed = JSON.parse(pipelineRunsRepository.lastSummary);
      metrics = parsed.saveMetrics;
    } catch (error) {
      console.warn('⚠️ 메트릭 파싱 실패:', error);
    }
  }

  let estimatedSecondsFor10k: number | undefined;
  if (metrics?.avgLatencyMs > 0) {
    const throughput = 1000 / metrics.avgLatencyMs;
    estimatedSecondsFor10k = Number((10000 / throughput).toFixed(2));
  }

  return {
    totalCases: fixtures.length,
    controllerResult: result,
    metrics,
    estimatedSecondsFor10k,
  };
}

async function persistRegressionReport(report: RegressionResult): Promise<string | null> {
  try {
    const dir = join(process.cwd(), 'logs', 'perf');
    await fs.mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = join(dir, `phase7-regression-${timestamp}.json`);
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
    return filePath;
  } catch (error) {
    console.warn('⚠️ 회귀 리포트 저장 실패:', error);
    return null;
  }
}

async function main(): Promise<void> {
  const fixtures = prepareScenario(200);
  const report = await runRegression(fixtures);
  const savedPath = await persistRegressionReport(report);

  console.log('—— Phase 7 Regression ——');
  console.log(`총 케이스: ${report.totalCases}`);
  console.log('저장 결과:', report.controllerResult);
  if (report.metrics) {
    console.log('성공률:', report.metrics.successRate);
    console.log('평균 지연(ms):', report.metrics.avgLatencyMs);
    console.log('P95 지연(ms):', report.metrics.p95LatencyMs);
    console.log('재시도 분포:', report.metrics.retries);
    console.log('실패 사유:', report.metrics.failureReasons);
  }
  if (report.estimatedSecondsFor10k) {
    console.log('10,000건 추정 소요(초):', report.estimatedSecondsFor10k);
  }
  if (savedPath) {
    console.log('리포트 파일:', savedPath);
  }
}

main().catch((error) => {
  console.error('회귀 스크립트 실패:', error);
  process.exit(1);
});
