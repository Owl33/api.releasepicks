/**
 * 단일 페어 수동 병합 스크립트 (한 쌍만 처리) - 2025-10-10
 * ---------------------------------------------------------
 * 목적:
 *  - SQL로 전수 조회/그룹핑 하지 않고, 사용자가 지정한 한 쌍(steam_only ↔ rawg_only)만 병합
 *
 * 지원 인자(둘 중 하나 방식으로 지정):
 *  1) games PK로 지정:
 *     --steam-row-id <number>    // games.id (steam_only 여야 함)
 *     --rawg-row-id  <number>    // games.id (rawg_only  여야 함)
 *
 *  2) 외부 ID로 지정:
 *     --steam-id <number>        // Steam AppID (steam_only)
 *     --rawg-id  <number>        // RAWG ID     (rawg_only)
 *
 *  보조:
 *     --dry-run                  // 실제 변경 없이 로깅만
 *
 * 동작 순서(유니크 충돌 방지 포함):
 *  - game_releases 이관(키 충돌 제거 → 이동)
 *  - game_details 삭제(요구사항: 이관 안 함)
 *  - loser(rawg_only) rawg_id NULL → keeper(steam_only) rawg_id 세팅
 *  - loser 삭제
 *  - keeper slug가 정확히 "-2"로 끝나면 꼬리 제거 시도(충돌 시 유지/대체)
  // npx ts-node scripts/merge-steam-rawg-by-ids.ts --steam-row-id 173411 --rawg-row-id 173538
*/

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';

type Sql = { query: (sql: string, params?: any[]) => Promise<any> };

type Args = {
  dryRun: boolean;
  steamRowId?: number;
  rawgRowId?: number;
  steamId?: number; // external
  rawgId?: number; // external
};

function num(v?: string) {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--dryrun') out.dryRun = true;
    else if (a === '--steam-row-id') out.steamRowId = num(argv[++i]);
    else if (a.startsWith('--steam-row-id='))
      out.steamRowId = num(a.split('=')[1]);
    else if (a === '--rawg-row-id') out.rawgRowId = num(argv[++i]);
    else if (a.startsWith('--rawg-row-id='))
      out.rawgRowId = num(a.split('=')[1]);
    else if (a === '--steam-id') out.steamId = num(argv[++i]);
    else if (a.startsWith('--steam-id=')) out.steamId = num(a.split('=')[1]);
    else if (a === '--rawg-id') out.rawgId = num(argv[++i]);
    else if (a.startsWith('--rawg-id=')) out.rawgId = num(a.split('=')[1]);
  }
  return out;
}

async function findRows(ds: Sql, args: Args) {
  // 우선순위 1: PK로 지정
  if (args.steamRowId && args.rawgRowId) {
    const [steam] = await ds.query(
      `SELECT id, name, slug, steam_id, rawg_id FROM public.games WHERE id = $1`,
      [args.steamRowId],
    );
    const [rawg] = await ds.query(
      `SELECT id, name, slug, steam_id, rawg_id FROM public.games WHERE id = $1`,
      [args.rawgRowId],
    );
    return { steam, rawg };
  }

  // 우선순위 2: 외부 ID로 지정
  if (args.steamId && args.rawgId) {
    const [steam] = await ds.query(
      `SELECT id, name, slug, steam_id, rawg_id
       FROM public.games WHERE steam_id = $1 AND rawg_id IS NULL`,
      [args.steamId],
    );
    const [rawg] = await ds.query(
      `SELECT id, name, slug, steam_id, rawg_id
       FROM public.games WHERE rawg_id = $1 AND steam_id IS NULL`,
      [args.rawgId],
    );
    return { steam, rawg };
  }

  throw new Error(
    '인자 오류: (--steam-row-id && --rawg-row-id) 또는 (--steam-id && --rawg-id) 를 함께 지정해야 합니다.',
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const ds = app.get(DataSource);

  try {
    console.log(
      `🚀 수동 병합 시작 (dryRun=${args.dryRun}) | 입력: steamRowId=${args.steamRowId ?? '-'}, rawgRowId=${args.rawgRowId ?? '-'}, steamId=${args.steamId ?? '-'}, rawgId=${args.rawgId ?? '-'}`,
    );

    const { steam, rawg } = await findRows(ds, args);
    if (!steam || !rawg)
      throw new Error(
        '지정한 조건에 해당하는 steam_only/rawg_only 행을 찾지 못했습니다.',
      );

    // 타입/상태 검증
    if (!(steam.steam_id && !steam.rawg_id))
      throw new Error(
        `steam 후보 #${steam.id} 는 (steam_only) 조건을 만족해야 합니다.`,
      );
    if (!(!rawg.steam_id && rawg.rawg_id))
      throw new Error(
        `rawg 후보 #${rawg.id} 는 (rawg_only) 조건을 만족해야 합니다.`,
      );

    console.log(
      `🧩 페어: "${steam.name}"\n   steam_only → #${steam.id} (sid:${steam.steam_id})\n   rawg_only  → #${rawg.id} (rid:${rawg.rawg_id})`,
    );

    if (args.dryRun) {
      console.log('   (dry-run) 업데이트/이관/삭제가 실행되지 않습니다.');
      await app.close();
      return;
    }

    await ds.transaction(async (tm) => {
      // 0) 두 행 잠금
      await tm.query(
        `SELECT id FROM public.games WHERE id = ANY($1) FOR UPDATE`,
        [[steam.id, rawg.id]],
      );

      // 1) releases 이관(키 충돌 제거 후 이동)
      await tm.query(
        `
        DELETE FROM public.game_releases fr
        USING public.game_releases tr
        WHERE fr.game_id = $1
          AND tr.game_id = $2
          AND fr.platform = tr.platform
          AND fr.store = tr.store
          AND COALESCE(fr.store_app_id,'') = COALESCE(tr.store_app_id,'')
      `,
        [rawg.id, steam.id],
      );
      const res1 = await tm.query(
        `WITH moved AS (
           UPDATE public.game_releases
              SET game_id = $2
            WHERE game_id = $1
            RETURNING 1
         ) SELECT COUNT(*)::int AS c FROM moved`,
        [rawg.id, steam.id],
      );
      const movedCount: number = res1?.[0]?.c ?? 0;
      console.log(`   🔁 releases 이관: ${movedCount}건`);

      // 2) game_details 삭제(이관 안 함)
      const res2 = await tm.query(
        `WITH del AS (
           DELETE FROM public.game_details WHERE game_id = $1 RETURNING 1
         ) SELECT COUNT(*)::int AS c FROM del`,
        [rawg.id],
      );
      const delDetails: number = res2?.[0]?.c ?? 0;
      console.log(`   🗑️ details 삭제: ${delDetails}건`);

      // 3) UNIQUE 충돌 방지: loser의 rawg_id NULL
      await tm.query(
        `UPDATE public.games SET rawg_id = NULL, updated_at = now() WHERE id = $1`,
        [rawg.id],
      );

      // 4) keeper에 rawg_id 주입
      if (!steam.rawg_id) {
        await tm.query(
          `UPDATE public.games SET rawg_id = $1, updated_at = now() WHERE id = $2`,
          [rawg.rawg_id, steam.id],
        );
        console.log(`   🔗 keeper #${steam.id} ← rawg_id ${rawg.rawg_id} 세팅`);
      } else if (steam.rawg_id !== rawg.rawg_id) {
        console.warn(
          `   ⚠️ keeper #${steam.id} 가 이미 rawg_id=${steam.rawg_id}를 보유: ${rawg.rawg_id}는 미적용`,
        );
      }

      // 5) loser 삭제
      await tm.query(`DELETE FROM public.games WHERE id = $1`, [rawg.id]);
      console.log(`   ❌ loser #${rawg.id} 삭제`);

      // 6) slug "-2" 제거 시도 (충돌 시 foo-3, foo-4...로 유니크 보장)
      const nowSteam = await tm.query(
        `SELECT slug FROM public.games WHERE id = $1`,
        [steam.id],
      );
      const currentSlug: string | null = nowSteam?.[0]?.slug ?? null;
      if (currentSlug && /-2$/.test(currentSlug)) {
        const cand = currentSlug.replace(/-2$/, '');
        if (cand.trim() !== '') {
          let final = cand;
          let n = 3; // "-2"를 뗐는데 충돌하면 "-3"부터 부여
          while (true) {
            const dup = await tm.query(
              `SELECT 1 FROM public.games WHERE slug = $1 AND id <> $2 LIMIT 1`,
              [final, steam.id],
            );
            if (dup.length === 0) break;
            final = `${cand}-${n++}`;
          }
          if (final !== currentSlug) {
            await tm.query(
              `UPDATE public.games SET slug = $1, updated_at = now() WHERE id = $2`,
              [final, steam.id],
            );
            console.log(`   🏷️ slug 정리: "${currentSlug}" → "${final}"`);
          }
        }
      }
    });

    console.log('✅ 완료');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main();
