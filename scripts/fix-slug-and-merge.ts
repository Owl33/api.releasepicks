/**
 * 슬러그 꼬리 제거 & 중복 병합 스크립트 (2025-10-10)
 * --------------------------------------------------
 * 대상:
 *  - games.slug 또는 games.og_slug 끝이 "-<steam_id>" 또는 "-<rawg_id>"로 끝나는 행
 *
 * 처리 순서:
 *  1) 후보 조회 → baseSlug(꼬리 제거), baseOgSlug 계산
 *  2) 같은 baseSlug + 같은 이름(소문자) 그룹핑
 *     - 그룹 내에 steam_id 있는 행을 keeper로, 나머지는 loser로 판단(원칙: steam 우선)
 *     - releases는 keeper로 이관(중복은 스킵/업데이트)
 *     - details는 상황에 따라 이관/삭제
 *     - loser 게임 행 삭제
 *  3) 병합이 필요 없는 단건은 꼬리만 제거
 *  4) slug / og_slug 최종 유니크 보장: 중복 시 -2, -3… 숫자 접미사
 *
 * 실행:
 *  - 드라이런:  npx ts-node scripts/fix-slug-and-merge.ts --dry-run
 *  - 상한 지정: npx ts-node scripts/fix-slug-and-merge.ts --limit 1000
 *  - 실제 실행: npx ts-node scripts/fix-slug-and-merge.ts
 *
 * 로그:
 *  - 모두 한글로 상세 표기
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';

type GameRow = {
  id: number;
  name: string;
  slug: string | null;
  og_slug: string | null;
  steam_id: number | null;
  rawg_id: number | null;
};
type SqlClient = {
  query: (sql: string, params?: any[]) => Promise<any>;
};
type Candidate = GameRow & {
  base_slug: string | null;
  base_og_slug: string | null;
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

/** 꼬리 제거: "-<id>" 로 끝나면 제거 */
function stripTail(
  val: string | null,
  steamId: number | null,
  rawgId: number | null,
): string | null {
  if (!val) return val;
  let out = val;
  if (steamId && new RegExp(`-${steamId}$`).test(out))
    out = out.replace(new RegExp(`-${steamId}$`), '');
  if (rawgId && new RegExp(`-${rawgId}$`).test(out))
    out = out.replace(new RegExp(`-${rawgId}$`), '');
  return out;
}

/** 유니크 슬러그 확보: 충돌 시 -2, -3 ... 붙여서 비파괴적으로 유니크 보장 */
async function ensureUniqueSlug(
  ds: SqlClient,
  candidate: string | null,
  selfId: number,
  column: 'slug' | 'og_slug',
): Promise<string | null> {
  if (!candidate || candidate.trim() === '') return candidate;
  let cand = candidate;
  let n = 2;
  // NOTE: ILIKE를 쓰지 않는 이유: 기존 유니크 인덱스는 대소문자 정확 매칭인 경우가 많음
  // 필요 시 LOWER(column) 인덱스 고려.
  while (true) {
    const exists = await ds.query(
      `SELECT 1 FROM public.games WHERE ${column} = $1 AND id <> $2 LIMIT 1`,
      [cand, selfId],
    );
    if (exists.length === 0) return cand;
    cand = `${candidate}-${n++}`;
  }
}

/** releases 이관: 충돌(동키) 존재 시 중복 삭제 or 필요한 필드 업데이트 후 삭제 */
async function migrateReleases(
  ds: SqlClient,
  fromGameId: number,
  toGameId: number,
) {
  // 동일키 기준: (platform, store, store_app_id)
  // 1) 충돌되는 것 먼저 정리: to에 이미 존재하는 키는 from에서 삭제
  await ds.query(
    `
    DELETE FROM public.game_releases fr
    USING public.game_releases tr
    WHERE fr.game_id = $1
      AND tr.game_id = $2
      AND fr.platform = tr.platform
      AND fr.store = tr.store
      AND COALESCE(fr.store_app_id,'') = COALESCE(tr.store_app_id,'')
  `,
    [fromGameId, toGameId],
  );

  // 2) 남은 from 모두 to로 이관
  await ds.query(
    `UPDATE public.game_releases SET game_id = $2 WHERE game_id = $1`,
    [fromGameId, toGameId],
  );
}

/** details 이관: keeper에 이미 있으면 loser 삭제, 없으면 이동 */
async function migrateDetails(
  ds: SqlClient,
  fromGameId: number,
  toGameId: number,
) {
  const to = await ds.query(
    `SELECT id FROM public.game_details WHERE game_id = $1`,
    [toGameId],
  );
  const from = await ds.query(
    `SELECT id FROM public.game_details WHERE game_id = $1`,
    [fromGameId],
  );

  if (from.length === 0) return;

  if (to.length > 0) {
    // keeper에 이미 디테일이 있으면 loser 디테일 삭제
    await ds.query(`DELETE FROM public.game_details WHERE game_id = $1`, [
      fromGameId,
    ]);
  } else {
    // keeper에 없으면 이관
    await ds.query(
      `UPDATE public.game_details SET game_id = $2 WHERE game_id = $1`,
      [fromGameId, toGameId],
    );
  }
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  const ds = app.get(DataSource);

  console.log(
    `🚀 슬러그/병합 정리 시작 (dryRun=${dryRun}, limit=${limit || 'ALL'})`,
  );

  // 1) 후보 조회
  const candidates: Candidate[] = await ds.query(
    `
    WITH base AS (
      SELECT
        g.id, g.name, g.slug, g.og_slug, g.steam_id, g.rawg_id,
        CASE
          WHEN g.slug IS NOT NULL THEN
            CASE
              WHEN g.steam_id IS NOT NULL AND g.slug ~ ('-' || g.steam_id::text || '$')
                THEN regexp_replace(g.slug, ('-' || g.steam_id::text || '$'), '')
              WHEN g.rawg_id  IS NOT NULL AND g.slug ~ ('-' || g.rawg_id::text  || '$')
                THEN regexp_replace(g.slug, ('-' || g.rawg_id::text  || '$'), '')
              ELSE g.slug
            END
          ELSE NULL
        END AS base_slug,
        CASE
          WHEN g.og_slug IS NOT NULL THEN
            CASE
              WHEN g.steam_id IS NOT NULL AND g.og_slug ~ ('-' || g.steam_id::text || '$')
                THEN regexp_replace(g.og_slug, ('-' || g.steam_id::text || '$'), '')
              WHEN g.rawg_id  IS NOT NULL AND g.og_slug ~ ('-' || g.rawg_id::text  || '$')
                THEN regexp_replace(g.og_slug, ('-' || g.rawg_id::text  || '$'), '')
              ELSE g.og_slug
            END
          ELSE NULL
        END AS base_og_slug
      FROM public.games g
      WHERE
        (g.steam_id IS NOT NULL AND (g.slug ~ ('-' || g.steam_id::text || '$')
          OR (g.og_slug IS NOT NULL AND g.og_slug ~ ('-' || g.steam_id::text || '$'))))
      OR  (g.rawg_id IS NOT NULL AND (g.slug ~ ('-' || g.rawg_id::text || '$')
          OR (g.og_slug IS NOT NULL AND g.og_slug ~ ('-' || g.rawg_id::text || '$'))))
    )
    SELECT * FROM base
    ORDER BY id
    ${limit > 0 ? `LIMIT ${limit}` : ''}
    `,
  );

  if (candidates.length === 0) {
    console.log('✅ 처리 대상이 없습니다.');
    await app.close();
    return;
  }

  // 2) 그룹핑: base_slug(우선) + 이름(소문자)
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${(c.base_slug ?? '').toLowerCase()}@@${(c.name ?? '').toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  console.log(`📦 후보 ${candidates.length}건 → 그룹 ${groups.size}개`);

  let mergedGroups = 0;
  let cleanedSingles = 0;
  let totalLosers = 0;

  // 3) 그룹 처리
  for (const [key, items] of groups.entries()) {
    // 병합 가능한가? (steam_id 가진 행이 있고, rawg_id 가진 '다른' 행이 하나 이상)
    const steamRows = items.filter((x) => x.steam_id);
    const rawgRows = items.filter((x) => x.rawg_id && (!x.steam_id || true));
    const needMerge =
      items.length >= 2 && steamRows.length >= 1 && rawgRows.length >= 1;

    if (needMerge) {
      mergedGroups++;
      // keeper: steam_id가 있는 행 중 하나(가능하면 steam+rawg 모두 가진 행, 그 외 첫 번째)
      const preferBoth = steamRows.find((x) => x.rawg_id);
      const keeper = preferBoth ?? steamRows[0];
      const losers = items.filter((x) => x.id !== keeper.id);
      totalLosers += losers.length;

      console.log(
        `🪄 [병합] base="${items[0].base_slug}" name="${items[0].name}" → keeper=#${keeper.id} (steam:${keeper.steam_id}, rawg:${keeper.rawg_id}), losers=${losers
          .map((l) => `#${l.id}(steam:${l.steam_id}, rawg:${l.rawg_id})`)
          .join(', ')}`,
      );

      if (!dryRun) {
        await ds.transaction(async (tm) => {
          // 3-1) losers를 순회하며 releases/details 이관
          for (const loser of losers) {
            // releases 이관
            await migrateReleases(tm, loser.id, keeper.id);
            // details 이관/삭제
            await migrateDetails(tm, loser.id, keeper.id);

            // keeper.rawg_id가 없고, loser.rawg_id가 있으면 keeper에 채우기
            if (!keeper.rawg_id && loser.rawg_id) {
              await tm.query(
                `UPDATE public.games SET rawg_id = $1, updated_at = now() WHERE id = $2`,
                [loser.rawg_id, keeper.id],
              );
              keeper.rawg_id = loser.rawg_id; // 로컬 객체 동기화
            }

            // loser 삭제
            await tm.query(`DELETE FROM public.games WHERE id = $1`, [
              loser.id,
            ]);
            console.log(
              `   🔁 loser #${loser.id} → 릴리스/디테일 이관 후 삭제`,
            );
          }

          // 3-2) keeper의 slug/og_slug 꼬리 제거 + 유니크 보장
          const newSlugBase = stripTail(
            keeper.slug,
            keeper.steam_id,
            keeper.rawg_id,
          );
          const newOgBase = stripTail(
            keeper.og_slug,
            keeper.steam_id,
            keeper.rawg_id,
          );

          const finalSlug = await ensureUniqueSlug(
            tm,
            newSlugBase,
            keeper.id,
            'slug',
          );
          const finalOg = await ensureUniqueSlug(
            tm,
            newOgBase,
            keeper.id,
            'og_slug',
          );

          if (finalSlug !== keeper.slug || finalOg !== keeper.og_slug) {
            await tm.query(
              `UPDATE public.games SET slug = $1, og_slug = $2, updated_at = now() WHERE id = $3`,
              [finalSlug, finalOg, keeper.id],
            );
            console.log(
              `   🏷️ keeper #${keeper.id} slug "${keeper.slug}"→"${finalSlug}", og_slug "${keeper.og_slug}"→"${finalOg}"`,
            );
          } else {
            console.log(`   ↔️ keeper #${keeper.id} 슬러그 변경 없음`);
          }
        });
      }
    } else {
      // 병합 불필요: 단일/느슨한 그룹 → 해당 행 각각 꼬리 제거만
      for (const it of items) {
        const baseChanged =
          stripTail(it.slug, it.steam_id, it.rawg_id) !== it.slug ||
          stripTail(it.og_slug, it.steam_id, it.rawg_id) !== it.og_slug;

        if (!baseChanged) continue;

        cleanedSingles++;
        console.log(
          `✂️ [정리] #${it.id} "${it.name}" slug="${it.slug}" og_slug="${it.og_slug}" → 꼬리 제거 적용`,
        );

        if (!dryRun) {
          await ds.transaction(async (tm) => {
            const newSlugBase = stripTail(it.slug, it.steam_id, it.rawg_id);
            const newOgBase = stripTail(it.og_slug, it.steam_id, it.rawg_id);
            const finalSlug = await ensureUniqueSlug(
              tm,
              newSlugBase,
              it.id,
              'slug',
            );
            const finalOg = await ensureUniqueSlug(
              tm,
              newOgBase,
              it.id,
              'og_slug',
            );

            await tm.query(
              `UPDATE public.games SET slug = $1, og_slug = $2, updated_at = now() WHERE id = $3`,
              [finalSlug, finalOg, it.id],
            );
            console.log(
              `   ✅ #${it.id} 최종 slug "${it.slug}"→"${finalSlug}", og_slug "${it.og_slug}"→"${finalOg}"`,
            );
          });
        }
      }
    }
  }

  console.log(
    `✅ 완료: 그룹=${groups.size}, 병합 그룹=${mergedGroups}, 단일 정리=${cleanedSingles}, 삭제된 loser 개수(예상)=${totalLosers}${
      dryRun ? ' (드라이런으로 실제 변경 없음)' : ''
    }`,
  );

  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
