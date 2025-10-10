/**
 * Missing Details/Release Backfill Script (로그 보강판)
 * ---------------------------------------------------
 * 파일: scripts/backfill-missing-details.ts
 *
 * 목적
 *  - 조건(인기도≥40, Steam/RAWG 외부 ID 존재, DLC 아님) 충족 게임 중
 *    ① game_details 미존재 또는 ② game_releases 미존재 항목을 찾아
 *    RAWG → Steam 순서로 보강(backfill)합니다.
 *
 * 주요 정책
 *  - 동일 게임에 대해 RAWG와 Steam을 "병렬"로 호출하지 않음 (락/경합 방지)
 *  - Steam 호출은 전 워커 공용 5분/200회 고정창(rate limit) 준수
 *  - RAWG는 자체 헤더 기반 리밋을 각 서비스에서 처리한다고 가정 (추가 대기 없음)
 *
 * 실행 방법 (CLI)
 *  - 전체 실행:   npx ts-node scripts/backfill-missing-details.ts
 *  - 상한 지정:   npx ts-node scripts/backfill-missing-details.ts --limit 5000
 *  - 드라이런:     npx ts-node scripts/backfill-missing-details.ts --dry-run
 *  - 동시성 조절:  npx ts-node scripts/backfill-missing-details.ts --concurrency 6
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { PipelineController } from '../src/pipeline/pipeline.controller';

type Candidate = {
  id: number;
  steam_id: number | null;
  rawg_id: number | null;
};

type Args = {
  limit: number; // 0이면 전체
  dryRun: boolean;
  concurrency: number; // 워커 수
};

/** ----- 간단한 CLI 파서 ----- */
function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 0, dryRun: false, concurrency: 4 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--dryrun') {
      out.dryRun = true;
    } else if (a === '--limit') {
      const v = Number(argv[i + 1]);
      if (!Number.isNaN(v) && v >= 0) out.limit = v;
      i++;
    } else if (a.startsWith('--limit=')) {
      const v = Number(a.split('=')[1]);
      if (!Number.isNaN(v) && v >= 0) out.limit = v;
    } else if (a === '--concurrency') {
      const v = Number(argv[i + 1]);
      if (!Number.isNaN(v) && v > 0) out.concurrency = v;
      i++;
    } else if (a.startsWith('--concurrency=')) {
      const v = Number(a.split('=')[1]);
      if (!Number.isNaN(v) && v > 0) out.concurrency = v;
    }
  }
  return out;
}

/** ----- 타임스템프 로그 유틸(한글) ----- */
const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const log = (...args: any[]) => console.log(`[${ts()}]`, ...args);
const warn = (...args: any[]) => console.warn(`[${ts()}] ⚠️`, ...args);
const err = (...args: any[]) => console.error(`[${ts()}] ❌`, ...args);

/** ----- Steam 고정창(5분/200회) 리미터 ----- */
class FixedWindowRateLimiter {
  private windowMs = 5 * 60 * 1000; // 5분
  private limit = 200;
  private count = 0;
  private windowStart = Date.now();

  constructor(limit?: number, windowMs?: number) {
    if (typeof limit === 'number' && limit > 0) this.limit = limit;
    if (typeof windowMs === 'number' && windowMs > 0) this.windowMs = windowMs;
  }

  /** 현재 창 상태 설명용 */
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

  /** 토큰 1개 소모. 초과 시 창 리셋까지 대기 */
  async take(label?: string) {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      // 창 갱신
      this.windowStart = now;
      this.count = 0;
      log(`🔄 [Steam 리밋] 새 창 시작 (5분/200회 초기화)`);
    }

    if (this.count >= this.limit) {
      const waitMs = this.windowMs - (now - this.windowStart);
      const sec = Math.ceil(waitMs / 1000);
      warn(
        `⏳ [Steam 리밋] 호출 한도 도달(200/5분). ${sec}초 대기 후 재개합니다${
          label ? ` — 대기 중: ${label}` : ''
        }`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      // 창 리셋
      this.windowStart = Date.now();
      this.count = 0;
      log(`🔄 [Steam 리밋] 대기 종료, 새 창 시작`);
    }

    this.count += 1;

    // 진행도 간단 로그(25, 50, 100, 150, 190 지점 등)
    if ([25, 50, 100, 150, 190, 199].includes(this.count)) {
      const snap = this.snapshot();
      log(
        `📈 [Steam 리밋] 사용 ${snap.used}/${this.limit} (남은 ${snap.remaining}, 리셋까지 ${Math.ceil(
          snap.resetInMs / 1000,
        )}초)`,
      );
    }
  }
}

async function main() {
  const { limit, dryRun, concurrency } = parseArgs(process.argv);
  log(`🚀 [백필 시작] limit=${limit || 'ALL'}, concurrency=${concurrency}, dryRun=${dryRun}`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  const dataSource = app.get(DataSource);
  const pipeline = app.get(PipelineController);

  // 1) 후보군 조회
  const sql = `
    WITH stats AS (
      SELECT COUNT(*) AS total
      FROM public.games g
      LEFT JOIN public.game_details d ON d.game_id = g.id
      WHERE g.popularity_score >= 40
        AND (g.steam_id IS NOT NULL OR g.rawg_id IS NOT NULL)
        AND g.game_type <> 'dlc'
        AND (
          d.id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.game_releases r WHERE r.game_id = g.id)
        )
    ),
    missing AS (
      SELECT g.id, g.steam_id, g.rawg_id
      FROM public.games g
      LEFT JOIN public.game_details d ON d.game_id = g.id
      WHERE g.popularity_score >= 40
        AND (g.steam_id IS NOT NULL OR g.rawg_id IS NOT NULL)
        AND g.game_type <> 'dlc'
        AND (
          d.id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.game_releases r WHERE r.game_id = g.id)
        )
    )
    SELECT id, steam_id, rawg_id
    FROM missing
    ORDER BY id
    ${limit > 0 ? `LIMIT ${limit}` : ''}
  `;

  log('🔎 [후보 조회] SQL 실행...');
  const candidates: Candidate[] = await dataSource.query(sql);
  log(`🎯 [후보 확보] 총 ${candidates.length}건`);
  try {
    const totalResult = await dataSource.query(
      `
      SELECT COUNT(*) AS total
      FROM public.games g
      LEFT JOIN public.game_details d ON d.game_id = g.id
      WHERE g.popularity_score >= 40
        AND (g.steam_id IS NOT NULL OR g.rawg_id IS NOT NULL)
        AND g.game_type <> 'dlc'
        AND (
          d.id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.game_releases r WHERE r.game_id = g.id)
        )
      `
    );
    if (Array.isArray(totalResult) && totalResult[0] && totalResult[0].total != null) {
      log(`📊 [전체 통계] 후보 전체 수: ${totalResult[0].total}`);
    } else {
      log('📊 [전체 통계] 후보 전체 수: 미확인');
    }
  } catch (e) {
    warn('⚠️ 전체 통계를 조회하지 못했습니다.', (e as Error).message);
  }

  if (!candidates.length) {
    log('✅ 보강 대상이 없습니다. 종료합니다.');
    await app.close();
    return;
  }

  // 2) 진행 카운터 및 리미터
  let idx = 0;
  let fail = 0;
  let okRawg = 0;
  let okSteam = 0;
  const limiter = new FixedWindowRateLimiter(200, 5 * 60 * 1000);

  // 3) 워커 풀
  const worker = async (wid: number) => {
    while (true) {
      const i = idx++;
      if (i >= candidates.length) break;

      const c = candidates[i];
      const info = `game=${c.id} (steam_id=${c.steam_id ?? '-'}, rawg_id=${c.rawg_id ?? '-'})`;

      log(`🧵#${wid} ▶ 처리 시작: ${info} (progress=${i + 1}/${candidates.length})`);

      // 3-1) RAWG 우선 (있을 때만)
      if (c.rawg_id) {
        log(`🧵#${wid} 🌐 RAWG 수집 시작: ${info} — dryRun=${dryRun}`);
        try {
          const res = await pipeline.executeManualSingleGame(String(c.id), {
            idKind: 'game',
            sources: 'rawg',
            mode: 'operational',
            dryRun: dryRun,
          } as any);
          okRawg++;
          log(
            `🧵#${wid} ✅ RAWG 수집 완료: ${info} — 메시지: ${res?.message ?? '성공'} (누적 RAWG 성공=${okRawg})`,
          );
        } catch (e: any) {
          fail++;
          err(`🧵#${wid} RAWG 수집 실패: ${info} — ${e?.message ?? e}`);
          // RAWG 실패해도 Steam은 시도 (독립 보강)
        }
      } else {
        log(`🧵#${wid} ↷ RAWG 건너뜀: rawg_id 없음 — ${info}`);
      }

      // 3-2) Steam (있을 때만, 리미트 존중)
      if (c.steam_id) {
        const label = `steam_id=${c.steam_id} / game=${c.id}`;
        await limiter.take(label);

        log(`🧵#${wid} 🔥 Steam 수집 시작: ${info} — dryRun=${dryRun}`);
        try {
          const res = await pipeline.executeManualSingleGame(String(c.id), {
            idKind: 'game',
            sources: 'steam',
            mode: 'operational',
            dryRun: dryRun,
          } as any);
          okSteam++;
          log(
            `🧵#${wid} ✅ Steam 수집 완료: ${info} — 메시지: ${res?.message ?? '성공'} (누적 Steam 성공=${okSteam})`,
          );
        } catch (e: any) {
          fail++;
          err(`🧵#${wid} Steam 수집 실패: ${info} — ${e?.message ?? e}`);
        }
      } else {
        log(`🧵#${wid} ↷ Steam 건너뜀: steam_id 없음 — ${info}`);
      }

      log(`🧵#${wid} ◀ 처리 종료: ${info}`);
    }
  };

  log(
    `🏁 [실행 개요] 워커=${concurrency}, Steam 리밋=5분/200회, 후보=${candidates.length}, dryRun=${dryRun}`,
  );

  const start = Date.now();
  const workers = Array.from({ length: Math.max(1, concurrency) }, (_, k) =>
    worker(k + 1),
  );
  await Promise.all(workers);
  const sec = ((Date.now() - start) / 1000).toFixed(1);

  const snap = limiter.snapshot();
  log('────────────────────────────────────────');
  log(`🏁 [요약] 총 대상=${candidates.length}, RAWG 성공=${okRawg}, Steam 성공=${okSteam}, 실패=${fail}`);
  log(
    `⏱️ [소요 시간] ${sec}s  |  [Steam 창 상태] 사용=${snap.used}/200, 남은=${snap.remaining}, 리셋까지≈${Math.ceil(
      snap.resetInMs / 1000,
    )}초`,
  );
  log('📒 세부 저장/실패 사유는 PipelineRun 메트릭 및 컨트롤러 로그를 참조하세요.');
  log('────────────────────────────────────────');

  await app.close();
}

main().catch((e) => {
  err('예상치 못한 오류로 종료합니다.', e);
  process.exit(1);
});
