/**
 * 단일 페어 수동 병합 스크립트 (한 쌍만 처리) - 2025-10-10
 * ---------------------------------------------------------
 * 목적:
 *  - SQL 전수 조회 없이, 지정한 한 쌍(steam_only ↔ rawg_only)만 병합
 *
 * 지원 인자(아래 중 하나 방식으로 지정):
 *  A) games PK로 명시:
 *     --steam-row-id <number>    // games.id (steam_only 여야 함)
 *     --rawg-row-id  <number>    // games.id (rawg_only  여야 함)
 *
 *  B) 외부 ID로 지정:
 *     --steam-id <number>        // Steam AppID (steam_only)
 *     --rawg-id  <number>        // RAWG ID     (rawg_only)
 *
 *  C) 내부 PK 두 개만(자동 판별):
 *     --row-id <number> --row-id <number>
 *     (또는 --rowid <number> --rowid <number>)  // 둘 다 허용
 *
 *  보조:
 *     --dry-run                  // 실제 변경 없이 로깅만
 *
 * 동작 순서(유니크 충돌 방지 포함):
 *  - game_releases 이관(키 충돌 제거 → 이동)
 *  - game_details 삭제(요구사항: 이관 안 함)
 *  - loser(rawg_only) rawg_id NULL → keeper(steam_only) rawg_id 세팅
 *  - loser 삭제
 *  - keeper slug가 정확히 "-2"로 끝나면 꼬리 제거 시도(충돌 시 foo-3, foo-4...로 유니크 보장)
   npx ts-node scripts/merge-steam-rawg-by-ids --row-id 12667 --row-id 174393 --allowNameMismatch 
*/

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';

type Sql = { query: (sql: string, params?: any[]) => Promise<any> };

type GameLite = {
  id: number;
  name: string;
  slug: string | null;
  steam_id: number | null;
  rawg_id: number | null;
};

type Args = {
  dryRun: boolean;
  steamRowId?: number;
  rawgRowId?: number;
  steamId?: number; // external
  rawgId?: number; // external
  rowIds: number[]; // generic games.id 2개
  allowNameMismatch?: boolean;
};

function num(v?: string) {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, rowIds: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--dryrun') out.dryRun = true;
    else if (a === '--allow-name-mismatch')
      out.allowNameMismatch = true; // ⬅️ 추가
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
    else if (a === '--row-id') {
      const v = num(argv[++i]);
      if (v != null) out.rowIds.push(v);
    } else if (a.startsWith('--row-id=')) {
      const v = num(a.split('=')[1]);
      if (v != null) out.rowIds.push(v);
    } else if (a === '--rowid') {
      const v = num(argv[++i]);
      if (v != null) out.rowIds.push(v);
    } else if (a.startsWith('--rowid=')) {
      const v = num(a.split('=')[1]);
      if (v != null) out.rowIds.push(v);
    }
  }
  return out;
}

async function loadGameById(
  ds: Sql,
  id: number,
): Promise<GameLite | undefined> {
  const rows = await ds.query(
    `SELECT id, name, slug, steam_id, rawg_id 
    FROM public.games 
    WHERE id = $1`,
    [id],
  );
  return rows?.[0];
}

async function findRows(
  ds: Sql,
  args: Args,
): Promise<{ steam: GameLite; rawg: GameLite }> {
  // 우선순위 1: PK로 명시
  if (args.steamRowId && args.rawgRowId) {
    const steam = await loadGameById(ds, args.steamRowId);
    const rawg = await loadGameById(ds, args.rawgRowId);
    if (!steam || !rawg) throw new Error('지정한 games.id를 찾을 수 없습니다.');
    return { steam, rawg };
  }

  // 우선순위 2: 외부 ID
  if (args.steamId && args.rawgId) {
    const [steam] = await ds.query(
      `SELECT id, name, slug, steam_id, rawg_id
         FROM public.games
        WHERE steam_id = $1 AND rawg_id IS NULL`,
      [args.steamId],
    );
    const [rawg] = await ds.query(
      `SELECT id, name, slug, steam_id, rawg_id
         FROM public.games
        WHERE rawg_id = $1 AND steam_id IS NULL`,
      [args.rawgId],
    );
    if (!steam || !rawg)
      throw new Error(
        '외부 ID로 지정한 steam_only/rawg_only 행을 찾지 못했습니다.',
      );
    return { steam, rawg };
  }

  // 우선순위 3: 내부 PK 2개(자동 판별)
  if (args.rowIds.length === 2) {
    const a = await loadGameById(ds, args.rowIds[0]);
    const b = await loadGameById(ds, args.rowIds[1]);
    if (!a || !b)
      throw new Error('지정한 --row-id 중 하나 이상을 찾을 수 없습니다.');

    // steam_only: steam_id != null && rawg_id is null
    // rawg_only : rawg_id  != null && steam_id is null
    const isSteamOnly = (g: GameLite) =>
      g.steam_id != null && g.rawg_id == null;
    const isRawgOnly = (g: GameLite) => g.rawg_id != null && g.steam_id == null;

    if (isSteamOnly(a) && isRawgOnly(b)) return { steam: a, rawg: b };
    if (isSteamOnly(b) && isRawgOnly(a)) return { steam: b, rawg: a };

    // 자세한 오류 설명
    const why = [
      `#${a.id}: steam_id=${a.steam_id ?? 'null'}, rawg_id=${a.rawg_id ?? 'null'}`,
      `#${b.id}: steam_id=${b.steam_id ?? 'null'}, rawg_id=${b.rawg_id ?? 'null'}`,
    ].join(' | ');
    throw new Error(
      `두 PK로 steam_only/rawg_only 자동 판별에 실패했습니다. (${why})`,
    );
  }

  throw new Error(
    '인자 오류: (A) --steam-row-id & --rawg-row-id, (B) --steam-id & --rawg-id, (C) --row-id 두 번 중 하나 형태로 지정하세요.',
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
      `🚀 수동 병합 시작 (dryRun=${args.dryRun}) | 입력: steamRowId=${args.steamRowId ?? '-'}, rawgRowId=${args.rawgRowId ?? '-'}, steamId=${args.steamId ?? '-'}, rawgId=${args.rawgId ?? '-'}, rowIds=[${args.rowIds.join(', ') || '-'}]`,
    );

    const { steam, rawg } = await findRows(ds, args);
    // 타입/상태 검증
    if (!(steam.steam_id && !steam.rawg_id))
      throw new Error(
        `steam 후보 #${steam.id} 는 (steam_only) 조건을 만족해야 합니다.`,
      );
    if (!(!rawg.steam_id && rawg.rawg_id))
      throw new Error(
        `rawg 후보 #${rawg.id} 는 (rawg_only) 조건을 만족해야 합니다.`,
      );
    if (steam.name !== rawg.name) {
      console.warn(
        `⚠️ 이름 불일치: steam(#${steam.id}) "${steam.name}" vs rawg(#${rawg.id}) "${rawg.name}"`,
      );
    }

    console.log(
      `🧩 페어: "${steam.name}"\n   steam_only → #${steam.id} (sid:${steam.steam_id})\n   rawg_only  → #${rawg.id} (rid:${rawg.rawg_id})`,
    );

    if (args.dryRun) {
      console.log('   (dry-run) 업데이트/이관/삭제가 실행되지 않습니다.');
      await app.close();
      return;
    }

    await ds.transaction(async (tm) => {
      // 0) 두 행 잠금(경합 방지) — 배열 캐스트 명시
      await tm.query(
        `SELECT id FROM public.games WHERE id = ANY($1::bigint[]) FOR UPDATE`,
        [[steam.id, rawg.id]],
      );

      // === 릴리즈 중복 제거 & 이동 (NULL-세이프, ENUM 캐스트, RLS 안전 로그) ===

      // 타깃 쪽 키셋 스냅샷
      const targetRows: Array<{
        id: string;
        platform: string;
        store: string;
        store_app_id: string | null;
      }> = await tm.query(
        `
      SELECT id::text,
             COALESCE(platform::text, '')   AS platform,
             COALESCE(store::text, '')      AS store,
             COALESCE(store_app_id, '')     AS store_app_id
      FROM public.game_releases
      WHERE game_id = $1
      `,
        [steam.id],
      );
      const targetKey = new Set(
        targetRows.map(
          (r) => `${r.platform}|${r.store}|${r.store_app_id ?? ''}`,
        ),
      );

      // 소스 쪽 전체 스냅샷
      const sourceRows: Array<{
        id: string;
        platform: string;
        store: string;
        store_app_id: string | null;
      }> = await tm.query(
        `
      SELECT id::text,
             COALESCE(platform::text, '')   AS platform,
             COALESCE(store::text, '')      AS store,
             COALESCE(store_app_id, '')     AS store_app_id
      FROM public.game_releases
      WHERE game_id = $1
      `,
        [rawg.id],
      );

      // 중복/이동 대상 분리
      const duplicateIds: string[] = [];
      const moveIds: string[] = [];
      for (const r of sourceRows) {
        const key = `${r.platform}|${r.store}|${r.store_app_id ?? ''}`;
        if (targetKey.has(key)) duplicateIds.push(r.id);
        else moveIds.push(r.id);
      }

      // 1) 중복만 정확히 삭제 (id 기반)
      let deletedCount = 0;
      if (duplicateIds.length) {
        const del = await tm.query(
          `
      DELETE FROM public.game_releases
      WHERE id = ANY($1::bigint[])
      RETURNING id
      `,
          [duplicateIds],
        );
        deletedCount = del.length;
      }

      // 2) 나머지만 이동 (id 기반) — UPDATE 후 검증 SELECT (RLS에도 정확한 로그)
      let movedCount = 0;
      if (moveIds.length) {
        await tm.query(
          `
      UPDATE public.game_releases
      SET game_id = $2
      WHERE id = ANY($1::bigint[])
        AND game_id = $3
      `,
          [moveIds, steam.id, rawg.id],
        );

        // 검증: 실제 target으로 간 것만 카운트
        const verify = await tm.query(
          `
      SELECT COUNT(*)::int AS c
      FROM public.game_releases
      WHERE id = ANY($1::bigint[])
        AND game_id = $2
      `,
          [moveIds, steam.id],
        );
        movedCount = verify?.[0]?.c ?? 0;

        if (movedCount !== moveIds.length) {
          const notMoved = await tm.query(
            `
        SELECT id, game_id,
               COALESCE(platform::text, '') AS platform,
               COALESCE(store::text, '')    AS store,
               COALESCE(store_app_id, '')   AS store_app_id
        FROM public.game_releases
        WHERE id = ANY($1::bigint[])
          AND game_id <> $2
        ORDER BY id
        `,
            [moveIds, steam.id],
          );
          console.warn('   ⚠️ 이동되지 않은 행:', notMoved);
        }
      }

      console.log(`   🗑️ 중복 릴리즈 삭제: ${deletedCount}건`);
      console.log(
        `   ➡️ 릴리즈 이동: 예상=${moveIds.length}건 / 실제=${movedCount}건`,
      );

      // 3) game_details 삭제(요구사항: 이관 안 함)
      const r2 = await tm.query(
        `WITH del AS (
       DELETE FROM public.game_details WHERE game_id = $1 RETURNING 1
     ) SELECT COUNT(*)::int AS c FROM del`,
        [rawg.id],
      );
      console.log(`   🗑️ details 삭제: ${r2?.[0]?.c ?? 0}건`);

      // 4) UNIQUE 충돌 회피: 먼저 loser.rawg_id NULL
      await tm.query(
        `UPDATE public.games SET rawg_id = NULL, updated_at = now() WHERE id = $1`,
        [rawg.id],
      );

      // 5) keeper에 rawg_id 주입(없을 때만)
      if (!steam.rawg_id) {
        await tm.query(
          `UPDATE public.games SET rawg_id = $1, updated_at = now() WHERE id = $2`,
          [rawg.rawg_id, steam.id],
        );
        console.log(`   🔗 keeper #${steam.id} ← rawg_id ${rawg.rawg_id} 세팅`);
      } else if (steam.rawg_id !== rawg.rawg_id) {
        console.warn(
          `   ⚠️ keeper #${steam.id} 가 이미 rawg_id=${steam.rawg_id} 보유 → ${rawg.rawg_id} 미적용`,
        );
      }

      // 6) loser 삭제
      await tm.query(`DELETE FROM public.games WHERE id = $1`, [rawg.id]);
      console.log(`   ❌ loser #${rawg.id} 삭제`);

      // 7) slug "-2" 제거 시도 (충돌 시 foo-3, foo-4... 유니크 보장)
      const cur = await tm.query(
        `SELECT slug FROM public.games WHERE id = $1`,
        [steam.id],
      );
      const currentSlug: string | null = cur?.[0]?.slug ?? null;
      if (currentSlug && /-2$/.test(currentSlug)) {
        const base = currentSlug.replace(/-2$/, '');
        if (base.trim() !== '') {
          let final = base;
          let n = 3;
          // 충돌 피하기
          while (true) {
            const dup = await tm.query(
              `SELECT 1 FROM public.games WHERE slug = $1 AND id <> $2 LIMIT 1`,
              [final, steam.id],
            );
            if (dup.length === 0) break;
            final = `${base}-${n++}`;
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
