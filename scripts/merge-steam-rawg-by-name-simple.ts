/**
 * steam_only + rawg_only 병합 스크립트 (이름 기준, 정렬된 SQL 결과만 처리) - 2025-10-10
 * -------------------------------------------------------------------------------------
 * 대상:
 *  - 아래 SQL 결과에 포함된 행만 처리 (baseSlug/출시일 일절 무시)
 *
 * 페어링:
 *  - 같은 name 그룹에서 steam_only[]와 rawg_only[]를 인덱스 순서대로 zip
 *
 * 실행:
 *  - 드라이런:  npx ts-node scripts/merge-steam-rawg-by-name-simple.ts --dry-run
 *  - 일부만:    npx ts-node scripts/merge-steam-rawg-by-name-simple.ts --limit 200
 *  - 실제:      npx ts-node scripts/merge-steam-rawg-by-name-simple.ts
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
type SqlClient = {
  query: (sql: string, params?: any[]) => Promise<any>;
};
type Row = {
  id: number;
  name: string;
  slug: string | null;
  steam_id: number | null;
  rawg_id: number | null;
  release_date_date: string | null;
  release_date_raw: string | null;
};

type Args = { dryRun: boolean; limit: number };

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--dryrun') out.dryRun = true;
    else if (a === '--limit') {
      const v = Number(argv[i + 1]);
      if (!Number.isNaN(v) && v >= 0) out.limit = v;
      i++;
    } else if (a.startsWith('--limit=')) {
      const v = Number(a.split('=')[1]);
      if (!Number.isNaN(v) && v >= 0) out.limit = v;
    }
  }
  return out;
}

/** slug가 정확히 "-2"로 끝나면 제거 시도. 충돌 나면 유지 */
async function tryStripMinus2Slug(
  ds: SqlClient,
  gameId: number,
  slug: string | null,
): Promise<{ changed: boolean; newSlug: string | null }> {
  if (!slug || !/-2$/.test(slug)) return { changed: false, newSlug: slug };
  const candidate = slug.replace(/-2$/, '');
  if (candidate.trim() === '') return { changed: false, newSlug: slug };

  const exists = await ds.query(
    `SELECT 1 FROM public.games WHERE slug = $1 AND id <> $2 LIMIT 1`,
    [candidate, gameId],
  );
  if (exists.length === 0) return { changed: true, newSlug: candidate };
  return { changed: false, newSlug: slug };
}

function groupByNamePreservingOrder(rows: Row[]): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.name; // 정렬은 SQL에서 보장됨
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(r);
  }
  return m;
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const ds = app.get(DataSource);

  console.log(`🚀 병합 시작 (dryRun=${dryRun}, limit=${limit || 'ALL'})`);
  console.log('📥 SQL 결과만 대상으로 페어링/병합을 수행합니다.');

  // === 핵심: 사용자 지정 SQL ===
  const rows: Row[] = await ds.query(
    `
    SELECT
      g.id, g.name, g.slug, g.steam_id, g.rawg_id,
      g.release_date_date, g.release_date_raw
    FROM public.games g
    WHERE
      (
        (g.steam_id IS NOT NULL AND g.rawg_id IS NULL) OR
        (g.rawg_id IS NOT NULL AND g.steam_id IS NULL)
      )
      AND EXISTS (
        SELECT 1 FROM public.games s
        WHERE s.name = g.name AND s.steam_id IS NOT NULL AND s.rawg_id IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM public.games r
        WHERE r.name = g.name AND r.rawg_id IS NOT NULL AND r.steam_id IS NULL
      )
    ORDER BY g.name,
             (g.steam_id IS NULL) ASC,  -- steam_only 먼저
             g.id
    `,
  );

  if (rows.length === 0) {
    console.log('✅ 처리 대상 없음');
    await app.close();
    return;
  }

  const grouped = groupByNamePreservingOrder(rows);
  console.log(`📦 이름 그룹 수: ${grouped.size} (총 행: ${rows.length})`);

  let processedPairs = 0;
  let deletedGames = 0;
  let movedReleases = 0;
  let deletedDetails = 0;
  let slugTrimmed = 0;

  outer: for (const [name, list] of grouped.entries()) {
    // SQL이 steam_only 먼저 오도록 보장하므로, 여기선 단순히 분리만 수행
    const steamList = list.filter((r) => r.steam_id && !r.rawg_id);
    const rawgList = list.filter((r) => r.rawg_id && !r.steam_id);

    if (steamList.length === 0 || rawgList.length === 0) continue;

    const pairCount = Math.min(steamList.length, rawgList.length);
    for (let i = 0; i < pairCount; i++) {
      if (limit > 0 && processedPairs >= limit) break outer;

      const steam = steamList[i];
      const rawg = rawgList[i];

      console.log(
        `🧩 페어: "${name}" steam#${steam.id}(sid:${steam.steam_id})  ⇐  rawg#${rawg.id}(rid:${rawg.rawg_id})`,
      );

      if (dryRun) {
        console.log('   (dry-run) 업데이트/이관/삭제가 실행되지 않습니다.');
        processedPairs++;
        continue;
      }

      await ds.transaction(async (tm) => {
        // 0) 두 행 잠금(경합 방지)
        const [rows] = await tm.query(
          `SELECT id, steam_id, rawg_id, slug FROM public.games WHERE id = ANY($1) FOR UPDATE`,
          [[steam.id, rawg.id]],
        );

        // 1) loser(rawg 전용)의 rawg_id 값을 변수에 보관
        const rawgIdToMove = rawg.rawg_id;
        if (!rawgIdToMove) {
          // 방어 로직: rawg 전용인데 rawg_id가 없다면 스킵/로그
          console.warn(
            `rawg-only row #${rawg.id} has no rawg_id. skip pairing.`,
          );
          return;
        }

        // 2) releases 먼저 이관 (충돌키 제거 후 이동)
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
        await tm.query(
          `UPDATE public.game_releases SET game_id = $2 WHERE game_id = $1`,
          [rawg.id, steam.id],
        );

        // 3) game_details는 이관하지 않고 삭제 (이번 작업 스펙)
        await tm.query(`DELETE FROM public.game_details WHERE game_id = $1`, [
          rawg.id,
        ]);

        // 4) 💥 유니크 충돌 방지: loser의 rawg_id를 먼저 NULL로 비움
        await tm.query(
          `UPDATE public.games SET rawg_id = NULL, updated_at = now() WHERE id = $1`,
          [rawg.id],
        );

        // 5) 이제 keeper에 rawg_id 주입 (충돌 없음)
        if (!steam.rawg_id) {
          await tm.query(
            `UPDATE public.games SET rawg_id = $1, updated_at = now() WHERE id = $2`,
            [rawgIdToMove, steam.id],
          );
        } else if (steam.rawg_id !== rawgIdToMove) {
          // 방어: 이미 값이 있는데 다르면 로그만 남기고, 필요시 정책에 따라 덮어쓰기/스킵 결정
          console.warn(
            `keeper #${steam.id} already has rawg_id=${steam.rawg_id}, skip assigning ${rawgIdToMove}`,
          );
        }

        // 6) loser 삭제
        await tm.query(`DELETE FROM public.games WHERE id = $1`, [rawg.id]);

        // 7) slug 정리: 하나만 남았고 slug가 정확히 "-2"로 끝나면 꼬리 제거 시도
        //    (유니크 보장 포함)
        const base = steam.slug || '';
        if (/-2$/.test(base)) {
          const cand = base.replace(/-2$/, '');
          // 유니크 확보 루프
          let final = cand;
          let n = 2;
          // 자기 자신 제외 충돌 검사
          // NOTE: 대소문자 구분 인덱스 기준. 환경에 따라 LOWER 인덱스 쓰면 로직 바꿔야 함.
          // 충돌 시 cand-2, cand-3... 재시도 (원래 -2는 제거하니 -2로 되돌리진 않음)
          // ex) "foo-2" -> "foo" 충돌이면 "foo-3"부터 시작
          while (true) {
            const dup = await tm.query(
              `SELECT 1 FROM public.games WHERE slug = $1 AND id <> $2 LIMIT 1`,
              [final, steam.id],
            );
            if (dup.length === 0) break;
            final = `${cand}-${++n}`; // foo-3, foo-4 ...
          }
          if (final !== base) {
            await tm.query(
              `UPDATE public.games SET slug = $1, updated_at = now() WHERE id = $2`,
              [final, steam.id],
            );
          }
        }
      });

      processedPairs++;
    }
  }

  console.log(
    `✅ 완료: 페어 ${processedPairs}건, releases 이관 ${movedReleases}건, details 삭제 ${deletedDetails}건, games 삭제 ${deletedGames}건, slug -2 제거 ${slugTrimmed}건${dryRun ? ' (드라이런)' : ''}`,
  );

  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
