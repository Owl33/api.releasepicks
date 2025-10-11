/**
 * update-steam-details-range.ts
 * ---------------------------------
 * - game_details.id BETWEEN 1 AND 6097 대상
 * - games.steam_id가 존재하는 row만 선정
 * - PipelineController.executeManualSingleGame 을 이용하여 Steam detail 재수집
 * 실행 예시:
 *   npx ts-node scripts/update-steam-details-range.ts           # 실제 반영
 *   npx ts-node scripts/update-steam-details-range.ts --dry-run # 미리보기
 *   npx ts-node scripts/update-steam-details-range.ts --limit 200
*/

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { PipelineController } from '../src/pipeline/pipeline.controller';

interface Candidate {
  game_id: number;
  detail_id: number;
  steam_id: number;
}

interface Args {
  limit: number;
  dryRun: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 0, dryRun: false, concurrency: 4 };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--dry-run' || token === '--dryrun') {
      args.dryRun = true;
    } else if (token === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isNaN(value) && value >= 0) args.limit = value;
    } else if (token.startsWith('--limit=')) {
      const value = Number(token.split('=')[1]);
      if (!Number.isNaN(value) && value >= 0) args.limit = value;
    } else if (token === '--concurrency') {
      const value = Number(argv[++i]);
      if (!Number.isNaN(value) && value > 0) args.concurrency = value;
    } else if (token.startsWith('--concurrency=')) {
      const value = Number(token.split('=')[1]);
      if (!Number.isNaN(value) && value > 0) args.concurrency = value;
    }
  }
  return args;
}

const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const log = (...args: any[]) => console.log(`[${ts()}]`, ...args);
const warn = (...args: any[]) => console.warn(`[${ts()}] ⚠️`, ...args);
const err = (...args: any[]) => console.error(`[${ts()}] ❌`, ...args);

class FixedWindowRateLimiter {
  private windowMs = 5 * 60 * 1000;
  private limit = 200;
  private count = 0;
  private windowStart = Date.now();

  snapshot() {
    const now = Date.now();
    const elapsed = now - this.windowStart;
    const remainMs = Math.max(0, this.windowMs - elapsed);
    return {
      used: this.count,
      remaining: Math.max(0, this.limit - this.count),
      resetInMs: remainMs,
    };
  }

  async take(label?: string) {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
      log('🔄 [Steam 리밋] 새 창 시작');
    }

    if (this.count >= this.limit) {
      const waitMs = this.windowMs - (now - this.windowStart);
      const sec = Math.ceil(waitMs / 1000);
      warn(`⏳ [Steam 리밋] 한도 도달. ${sec}초 대기${label ? ` (${label})` : ''}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.windowStart = Date.now();
      this.count = 0;
      log('🔄 [Steam 리밋] 대기 종료, 새 창 시작');
    }

    this.count += 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  log(`🚀 [Steam detail 범위 업데이트] limit=${args.limit || 'ALL'}, concurrency=${args.concurrency}, dryRun=${args.dryRun}`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  const dataSource = app.get(DataSource);
  const pipeline = app.get(PipelineController);

  const sql = `
    WITH candidates AS (
      SELECT g.id AS game_id,
             d.id AS detail_id,
             g.steam_id
      FROM public.game_details d
      JOIN public.games g ON g.id = d.game_id
      WHERE d.id BETWEEN 1 AND 6097
        AND g.steam_id IS NOT NULL
      ORDER BY d.id
    )
    SELECT game_id, detail_id, steam_id
    FROM candidates
    ${args.limit > 0 ? `LIMIT ${args.limit}` : ''}
  `;

  log('🔎 [후보 조회] SQL 실행...');
  const candidates: Candidate[] = await dataSource.query(sql);
  log(`🎯 [후보 확보] 총 ${candidates.length}건`);

  try {
    const totalResult = await dataSource.query(
      `
      SELECT COUNT(*) AS total
      FROM public.game_details d
      JOIN public.games g ON g.id = d.game_id
      WHERE d.id BETWEEN 1 AND 6097
        AND g.steam_id IS NOT NULL
      `,
    );
    if (Array.isArray(totalResult) && totalResult[0]?.total != null) {
      log(`📊 [전체 통계] 대상 전체 수: ${totalResult[0].total}`);
    }
  } catch (e) {
    warn('⚠️ 전체 통계를 조회하지 못했습니다.', (e as Error).message);
  }

  if (!candidates.length) {
    log('✅ 대상이 없습니다. 종료합니다.');
    await app.close();
    return;
  }

  const limiter = new FixedWindowRateLimiter();
  let index = 0;
  let success = 0;
  let failed = 0;

  const worker = async (wid: number) => {
    while (true) {
      const current = index++;
      if (current >= candidates.length) break;

      const c = candidates[current];
      const info = `game=${c.game_id} (detail=${c.detail_id}, steam=${c.steam_id})`;
      log(`🧵#${wid} ▶ 처리 시작: ${info} (progress=${current + 1}/${candidates.length})`);

      await limiter.take(`steam_id=${c.steam_id}`);
      try {
        const res = await pipeline.executeManualSingleGame(String(c.game_id), {
          idKind: 'game',
          sources: 'steam',
          mode: 'operational',
          dryRun: args.dryRun,
        } as any);
        success += 1;
        log(`🧵#${wid} ✅ Steam detail 업데이트 완료: ${info} — ${res?.message ?? '성공'} (누적=${success})`);
      } catch (e: any) {
        failed += 1;
        err(`🧵#${wid} Steam detail 업데이트 실패: ${info} — ${e?.message ?? e}`);
      }

      log(`🧵#${wid} ◀ 처리 종료: ${info}`);
    }
  };

  log(`🏁 [실행 개요] 워커=${args.concurrency}, 후보=${candidates.length}, dryRun=${args.dryRun}`);

  const start = Date.now();
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, (_, i) => worker(i + 1));
  await Promise.all(workers);
  const sec = ((Date.now() - start) / 1000).toFixed(1);

  const snap = limiter.snapshot();
  log('────────────────────────────────────────');
  log(`🏁 [요약] 총 대상=${candidates.length}, Steam 성공=${success}, 실패=${failed}`);
  log(`⏱️ [소요 시간] ${sec}s | [Steam 창] 사용=${snap.used}/200, 남은=${snap.remaining}, 리셋까지≈${Math.ceil(snap.resetInMs / 1000)}초`);
  log('📒 상세 결과는 PipelineRun 로그를 확인하세요.');
  log('────────────────────────────────────────');

  await app.close();
}

main().catch((e) => {
  err('예상치 못한 오류로 종료합니다.', e);
  process.exit(1);
});
