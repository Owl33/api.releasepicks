/**
 * 슬러그 규칙 적용 스크립트
 * ---------------------------------------
 * - 신규 Slug 정책(DefaultSlugPolicyService)을 사용하여
 *   games.slug / games.og_slug 값을 일괄 재계산한다.
 *
 * 실행 예시:
 *   npx ts-node scripts/update-slugs-to-policy.ts           # 실제 반영
 *   npx ts-node scripts/update-slugs-to-policy.ts --dry-run # 미리보기
 *   npx ts-node scripts/update-slugs-to-policy.ts --limit 200
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import slugify from 'slugify';

type Args = {
  dryRun: boolean;
  limit?: number;
  concurrency: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, concurrency: 4 };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run' || token === '--dryrun') {
      args.dryRun = true;
    } else if (token === '--limit' && i + 1 < argv.length) {
      const parsed = Number(argv[i + 1]);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.limit = parsed;
      }
      i += 1;
    } else if (token.startsWith('--limit=')) {
      const parsed = Number(token.split('=')[1]);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.limit = parsed;
      }
    } else if (token === '--concurrency' && i + 1 < argv.length) {
      const parsed = Number(argv[i + 1]);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.concurrency = Math.max(1, Math.floor(parsed));
      }
      i += 1;
    } else if (token.startsWith('--concurrency=')) {
      const parsed = Number(token.split('=')[1]);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.concurrency = Math.max(1, Math.floor(parsed));
      }
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  const startedAt = Date.now();
  try {
    const dataSource = app.get(DataSource);
    const manager = dataSource.manager;

    // eslint-disable-next-line no-console
    console.log(
      `🚀 슬러그 재계산 시작 (dryRun=${args.dryRun ? 'yes' : 'no'}, limit=${
        args.limit ?? '∞'
      }, concurrency=${args.concurrency})`,
    );

    const params: any[] = [];
    let sql = `
      SELECT id, name, og_name, slug, og_slug, steam_id, rawg_id
      FROM public.games
      ORDER BY id
    `;
    if (args.limit && args.limit > 0) {
      sql += ' LIMIT $1';
      params.push(args.limit);
    }

    const slugSnapshot: Array<{ slug: string | null; og_slug: string | null }> =
      await manager.query(`SELECT slug, og_slug FROM public.games`);

    const slugSet = new Set<string>();
    const ogSlugSet = new Set<string>();
    slugSnapshot.forEach((row) => {
      if (row.slug) slugSet.add(row.slug.toLowerCase());
      if (row.og_slug) ogSlugSet.add(row.og_slug.toLowerCase());
    });

    const rows: Array<{
      id: number;
      name: string;
      og_name: string | null;
      slug: string | null;
      og_slug: string | null;
      steam_id: number | null;
      rawg_id: number | null;
    }> = await manager.query(sql, params);

    if (rows.length === 0) {
      // eslint-disable-next-line no-console
      console.log('ℹ️ 갱신할 게임이 없습니다.');
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`📦 대상 게임 수: ${rows.length}`);

    const total = rows.length;
    const concurrency = Math.min(
      Math.max(1, args.concurrency),
      Math.max(1, total),
    );
    let changed = 0;
    let nextIndex = 0;

    const mutex = new Mutex();

    const processRow = async (rowIndex: number): Promise<void> => {
      const row = rows[rowIndex];
      const processed = rowIndex + 1;
      const remaining = total - processed;

      // eslint-disable-next-line no-console
      console.log(
        `▶️ ${processed}/${total} (남음:${remaining}) id=${row.id} "${row.name}"`,
      );

      let result: SlugComputationResult | undefined;
      await mutex.runExclusive(async () => {
        result = computeNewSlugs(row, slugSet, ogSlugSet);
      });
      if (!result) {
        throw new Error('슬러그 계산 중 알 수 없는 오류가 발생했습니다.');
      }

      if (!result.changed) {
        // eslint-disable-next-line no-console
        console.log('   ⚪ 변경 없음 (slug/og_slug 동일)');
        return;
      }

      changed += 1;

      if (args.dryRun) {
        // eslint-disable-next-line no-console
        console.log(
          `[DRY] id=${row.id} "${row.name}" | slug: ${row.slug} → ${result.slug} | og_slug: ${row.og_slug} → ${result.ogSlug}`,
        );
      } else {
        try {
          await manager.query(
            `UPDATE public.games
               SET slug = $1,
                   og_slug = $2,
                   updated_at = NOW()
             WHERE id = $3`,
            [result.slug, result.ogSlug, row.id],
          );
          // eslint-disable-next-line no-console
          console.log(
            `✅ 업데이트 완료 id=${row.id} "${row.name}" | slug: ${row.slug} → ${result.slug} | og_slug: ${row.og_slug} → ${result.ogSlug}`,
          );
        } catch (error) {
          const safeResult = result;
          await mutex.runExclusive(async () => {
            if (safeResult) {
              rollbackSlugSets(safeResult, slugSet, ogSlugSet);
            }
          });
          throw error;
        }
      }
    };

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= total) break;
        await processRow(currentIndex);
      }
    });

    await Promise.all(workers);

    if (args.dryRun) {
      // eslint-disable-next-line no-console
      console.log(
        `드라이런 종료 - 변경 예상 건수: ${changed}/${rows.length}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `실행 완료 - 변경된 건수: ${changed}/${rows.length}`,
      );
    }

    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(`⏱️ 총 소요 시간: ${durationSeconds}s`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('슬러그 업데이트 스크립트 실패:', error);
  process.exitCode = 1;
});

type SlugComputationResult = {
  changed: boolean;
  slug: string;
  ogSlug: string;
  slugChanged: boolean;
  ogChanged: boolean;
  previousSlugLower: string | null;
  previousOgSlugLower: string | null;
};

function computeNewSlugs(
  row: {
    id: number;
    name: string;
    og_name: string | null;
    slug: string | null;
    og_slug: string | null;
    steam_id: number | null;
    rawg_id: number | null;
  },
  slugSet: Set<string>,
  ogSlugSet: Set<string>,
): SlugComputationResult {
  const previousSlugLower = row.slug ? row.slug.toLowerCase() : null;
  const previousOgSlugLower = row.og_slug ? row.og_slug.toLowerCase() : null;

  if (previousSlugLower) slugSet.delete(previousSlugLower);
  if (previousOgSlugLower) ogSlugSet.delete(previousOgSlugLower);

  const slug = generateSlug({
    preferred: row.slug,
    fallbackName: row.name,
    fallbackCandidates: [
      row.steam_id ? `steam-${row.steam_id}` : null,
      row.rawg_id ? `rawg-${row.rawg_id}` : null,
      `game-${row.id}`,
    ],
    existing: slugSet,
  });

  const ogSlug = generateSlug({
    preferred: row.og_slug,
    fallbackName: row.og_name ?? row.name,
    fallbackCandidates: [
      row.steam_id ? `steam-${row.steam_id}` : null,
      row.rawg_id ? `rawg-${row.rawg_id}` : null,
      `game-${row.id}`,
    ],
    existing: ogSlugSet,
  });

  const slugLower = slug.toLowerCase();
  const ogLower = ogSlug.toLowerCase();
  slugSet.add(slugLower);
  ogSlugSet.add(ogLower);

  const slugChanged = slug !== (row.slug ?? '');
  const ogChanged = ogSlug !== (row.og_slug ?? '');

  return {
    changed: slugChanged || ogChanged,
    slug,
    ogSlug,
    slugChanged,
    ogChanged,
    previousSlugLower,
    previousOgSlugLower,
  };
}

function rollbackSlugSets(
  result: SlugComputationResult,
  slugSet: Set<string>,
  ogSlugSet: Set<string>,
): void {
  slugSet.delete(result.slug.toLowerCase());
  ogSlugSet.delete(result.ogSlug.toLowerCase());

  if (result.previousSlugLower) slugSet.add(result.previousSlugLower);
  if (result.previousOgSlugLower) ogSlugSet.add(result.previousOgSlugLower);
}

function generateSlug(options: {
  preferred: string | null;
  fallbackName: string | null;
  fallbackCandidates: Array<string | null>;
  existing: Set<string>;
}): string {
  const { preferred, fallbackName, fallbackCandidates, existing } = options;

  let base =
    normalizeCandidate(preferred) ??
    normalizeCandidate(fallbackName) ??
    fallbackCandidates
      .map((candidate) => normalizeCandidate(candidate))
      .find((candidate): candidate is string => typeof candidate === 'string') ??
    'game';

  base = truncate(base);

  let candidate = base;
  let counter = 2;
  while (existing.has(candidate.toLowerCase())) {
    const suffix = String(counter++);
    const maxBaseLength = Math.max(1, 120 - suffix.length - 1);
    const trimmedBase = truncate(base, maxBaseLength);
    candidate = `${trimmedBase}-${suffix}`;
  }

  return candidate;
}

function normalizeCandidate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = slugify(trimmed, {
    lower: true,
    strict: false,
    locale: 'ko',
    replacement: '-',
    trim: true,
    remove: /[^a-zA-Z0-9가-힣\s-]/g,
  })
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!normalized) return null;
  return truncate(normalized);
}

function truncate(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  private acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        const next = this.waiters.shift();
        if (next) {
          next();
        } else {
          this.locked = false;
        }
      };

      if (this.locked) {
        this.waiters.push(() => resolve(release));
      } else {
        this.locked = true;
        resolve(release);
      }
    });
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
