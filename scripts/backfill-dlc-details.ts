/**
 * DLC Details/Release Backfill Script
 * -----------------------------------
 * - parents with popularity >= 40 allow DLC detail & release storage (Phase 4 policy)
 * - 대상: game_type = 'dlc' AND (game_details 없음 OR game_releases 없음)
 * - 우선 RAWG, 이후 Steam 순으로 수집. (둘 다 있으면 순차 실행)
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { PipelineController } from '../src/pipeline/pipeline.controller';

interface Candidate {
  id: number;
  steam_id: number | null;
  rawg_id: number | null;
  parent_popularity: number | null;
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

  constructor(limit?: number, windowMs?: number) {
    if (limit && limit > 0) this.limit = limit;
    if (windowMs && windowMs > 0) this.windowMs = windowMs;
  }

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
      log(`🔄 [Steam 리밋] 새 창 시작`);
    }

    if (this.count >= this.limit) {
      const waitMs = this.windowMs - (now - this.windowStart);
      const sec = Math.ceil(waitMs / 1000);
      warn(
        `⏳ [Steam 리밋] 한도 도달. ${sec}초 대기${label ? ` (${label})` : ''}`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.windowStart = Date.now();
      this.count = 0;
      log(`🔄 [Steam 리밋] 대기 종료, 새 창 시작`);
    }

    this.count += 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  log(
    `🚀 [DLC 백필 시작] limit=${args.limit || 'ALL'}, concurrency=${args.concurrency}, dryRun=${args.dryRun}`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  const dataSource = app.get(DataSource);
  const pipeline = app.get(PipelineController);

  const sql = `
    WITH parent AS (
      SELECT child.id,
             child.steam_id,
             child.rawg_id,
             parent.popularity_score AS parent_popularity
      FROM public.games child
      LEFT JOIN public.games parent ON
        (child.parent_steam_id IS NOT NULL AND parent.steam_id = child.parent_steam_id)
        OR (child.parent_rawg_id IS NOT NULL AND parent.rawg_id = child.parent_rawg_id)
      WHERE child.game_type = 'dlc'
        AND COALESCE(parent.popularity_score, 0) >= 40
    ),
    missing AS (
      SELECT p.id, p.steam_id, p.rawg_id, p.parent_popularity
      FROM parent p
      LEFT JOIN public.game_details d ON d.game_id = p.id
      WHERE d.id IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.game_releases r WHERE r.game_id = p.id)
    )
    SELECT id, steam_id, rawg_id, parent_popularity
    FROM missing
    ORDER BY id
    ${args.limit > 0 ? `LIMIT ${args.limit}` : ''}
  `;

  log('🔎 [DLC 후보 조회] SQL 실행...');
  const candidates: Candidate[] = await dataSource.query(sql);
  log(`🎯 [DLC 후보 확보] 총 ${candidates.length}건`);

  if (!candidates.length) {
    log('✅ DLC 보강 대상이 없습니다. 종료합니다.');
    await app.close();
    return;
  }

  const limiter = new FixedWindowRateLimiter(200, 5 * 60 * 1000);
  let index = 0;
  let okRawg = 0;
  let okSteam = 0;
  let failed = 0;

  const worker = async (wid: number) => {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= candidates.length) break;

      const c = candidates[currentIndex];
      const info = `dlc=${c.id} (steam=${c.steam_id ?? '-'}, rawg=${c.rawg_id ?? '-'}, parentPopularity=${c.parent_popularity ?? '-'})`;
      log(
        `🧵#${wid} ▶ 처리 시작: ${info} (progress=${currentIndex + 1}/${candidates.length})`,
      );

      // if (c.rawg_id) {
      //   log(`🧵#${wid} 🌐 RAWG 수집 시작: ${info}`);
      //   try {
      //     const res = await pipeline.executeManualSingleGame(String(c.id), {
      //       idKind: 'game',
      //       sources: 'rawg',
      //       mode: 'operational',
      //       dryRun: args.dryRun,
      //     } as any);
      //     okRawg += 1;
      //     log(`🧵#${wid} ✅ RAWG 완료: ${info} — ${res?.message ?? '성공'} (누적=${okRawg})`);
      //   } catch (e: any) {
      //     failed += 1;
      //     err(`🧵#${wid} RAWG 실패: ${info} — ${e?.message ?? e}`);
      //   }
      // } else {
      //   log(`🧵#${wid} ↷ RAWG 건너뜀: rawg_id 없음 — ${info}`);
      // }

      if (c.steam_id) {
        await limiter.take(`steam_id=${c.steam_id}`);
        log(`🧵#${wid} 🔥 Steam 수집 시작: ${info}`);
        try {
          const res = await pipeline.executeManualSingleGame(String(c.id), {
            idKind: 'game',
            sources: 'steam',
            mode: 'operational',
            dryRun: args.dryRun,
          } as any);
          okSteam += 1;
          log(
            `🧵#${wid} ✅ Steam 완료: ${info} — ${res?.message ?? '성공'} (누적=${okSteam})`,
          );
        } catch (e: any) {
          failed += 1;
          err(`🧵#${wid} Steam 실패: ${info} — ${e?.message ?? e}`);
        }
      } else {
        log(`🧵#${wid} ↷ Steam 건너뜀: steam_id 없음 — ${info}`);
      }

      log(`🧵#${wid} ◀ 처리 종료: ${info}`);
    }
  };

  log(
    `🏁 [실행 개요] 워커=${args.concurrency}, 후보=${candidates.length}, dryRun=${args.dryRun}`,
  );
  const start = Date.now();
  const workers = Array.from(
    { length: Math.max(1, args.concurrency) },
    (_, i) => worker(i + 1),
  );
  await Promise.all(workers);
  const sec = ((Date.now() - start) / 1000).toFixed(1);

  const snap = limiter.snapshot();
  log('────────────────────────────────────────');
  log(
    `🏁 [요약] 총 대상=${candidates.length}, RAWG 성공=${okRawg}, Steam 성공=${okSteam}, 실패=${failed}`,
  );
  log(
    `⏱️ [소요 시간] ${sec}s | [Steam 창] 사용=${snap.used}/200, 남은=${snap.remaining}, 리셋까지≈${Math.ceil(snap.resetInMs / 1000)}초`,
  );
  log('📒 자세한 저장 결과는 PipelineRun 로그를 참조하세요.');
  log('────────────────────────────────────────');

  await app.close();
}

main().catch((e) => {
  err('예상치 못한 오류로 종료합니다.', e);
  process.exit(1);
});
