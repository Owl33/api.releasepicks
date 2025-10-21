/**
 * 슬러그 재계산 스크립트 (인메모리 전환)
 * ---------------------------------------
 * - steam_id가 존재하는 모든 게임을 로드해 slug / og_slug를 일괄 재계산합니다.
 * - 인메모리 Set으로 고유성을 관리해 중복을 방지합니다.
 * - 변경된 레코드만 순차적으로 UPDATE 합니다 (고유 제약 충돌 방지).
 *
 * 실행 예시:
 *   npx ts-node scripts/update-slugs-to-policy.ts --dry-run --limit 200
 *   npx ts-node scripts/update-slugs-to-policy.ts --chunk 500
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { Game } from '../src/entities/game.entity';
import { normalizeSlugCandidate } from '../src/common/slug/slug-normalizer.util';

interface CliOptions {
  dryRun: boolean;
  limit?: number;
  onlyId?: number;
  chunkSize: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, chunkSize: 500 };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run' || token === '--dryrun') {
      options.dryRun = true;
    } else if (token === '--limit' && i + 1 < argv.length) {
      const parsed = Number(argv[++i]);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = Math.floor(parsed);
    } else if (token.startsWith('--limit=')) {
      const parsed = Number(token.split('=')[1]);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = Math.floor(parsed);
    } else if (token === '--only-id' && i + 1 < argv.length) {
      const parsed = Number(argv[++i]);
      if (!Number.isNaN(parsed) && parsed > 0) options.onlyId = Math.floor(parsed);
    } else if (token.startsWith('--only-id=')) {
      const parsed = Number(token.split('=')[1]);
      if (!Number.isNaN(parsed) && parsed > 0) options.onlyId = Math.floor(parsed);
    } else if (token === '--chunk' && i + 1 < argv.length) {
      const parsed = Number(argv[++i]);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.chunkSize = Math.min(5000, Math.max(50, Math.floor(parsed)));
      }
    } else if (token.startsWith('--chunk=')) {
      const parsed = Number(token.split('=')[1]);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.chunkSize = Math.min(5000, Math.max(50, Math.floor(parsed)));
      }
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const dataSource = app.get(DataSource);
    const repository = dataSource.getRepository(Game);

    const qb = repository
      .createQueryBuilder('game')
      .select([
        'game.id',
        'game.name',
        'game.og_name',
        'game.slug',
        'game.og_slug',
        'game.steam_id',
        'game.rawg_id',
      ])
      .where('game.steam_id IS NOT NULL')
      .orderBy('game.id', 'ASC');

    if (options.onlyId) qb.andWhere('game.id = :onlyId', { onlyId: options.onlyId });
    if (options.limit) qb.take(options.limit);

    const games = await qb.getMany();
    if (games.length === 0) {
      console.log('ℹ️ 대상 게임이 없습니다.');
      return;
    }

    const total = games.length;
    console.log(`🚀 슬러그 재계산 시작 (dryRun=${options.dryRun ? 'yes' : 'no'}, count=${total})`);

    const slugSet = new Set<string>();
    const ogSlugSet = new Set<string>();
    games.forEach((game) => {
      if (game.slug) slugSet.add(game.slug.toLowerCase());
      if (game.og_slug) ogSlugSet.add(game.og_slug.toLowerCase());
    });

    const updates: SlugUpdate[] = [];

    games.forEach((game, index) => {
      const prefix = `[${index + 1}/${total}] id=${game.id}`;

      const oldSlugLower = game.slug ? game.slug.toLowerCase() : null;
      const oldOgSlugLower = game.og_slug ? game.og_slug.toLowerCase() : null;

      if (oldSlugLower) slugSet.delete(oldSlugLower);
      if (oldOgSlugLower) ogSlugSet.delete(oldOgSlugLower);

      const newSlug = ensureUniqueSlug(
        buildBaseCandidate(game.name, game.steam_id, game.rawg_id),
        slugSet,
        oldSlugLower,
      );
      const newOgSlug = ensureUniqueSlug(
        buildBaseCandidate(game.og_name ?? game.name, game.steam_id, game.rawg_id),
        ogSlugSet,
        oldOgSlugLower,
      );

      slugSet.add(newSlug.toLowerCase());
      ogSlugSet.add(newOgSlug.toLowerCase());

      const slugChanged = newSlug !== (game.slug ?? '');
      const ogChanged = newOgSlug !== (game.og_slug ?? '');

      if (!slugChanged && !ogChanged) {
        console.log(`${prefix} ⚪ 변경 없음 (slug=${game.slug}, og_slug=${game.og_slug})`);
        return;
      }

      if (options.dryRun) {
        console.log(
          `${prefix} [DRY] slug: ${game.slug} → ${newSlug}, og_slug: ${game.og_slug} → ${newOgSlug}`,
        );
        return;
      }

      updates.push({
        id: game.id,
        slug: newSlug,
        ogSlug: newOgSlug,
        oldSlug: game.slug,
        oldOgSlug: game.og_slug,
        logPrefix: prefix,
      });
    });

    if (options.dryRun) {
      console.log(`✨ 드라이런 종료 (변경 예정 건수: ${updates.length}/${total})`);
      return;
    }

    if (updates.length === 0) {
      console.log('✨ 변경된 게임이 없습니다.');
      return;
    }

    await performUpdates(dataSource, updates, options.chunkSize);

    console.log(`✨ 작업 완료 (변경된 게임: ${updates.length}/${total})`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('❌ 슬러그 업데이트 스크립트 실패:', error);
  process.exitCode = 1;
});

interface SlugUpdate {
  id: number;
  slug: string;
  ogSlug: string;
  oldSlug: string | null;
  oldOgSlug: string | null;
  logPrefix: string;
}

const MAX_SLUG_LENGTH = 120;

function buildBaseCandidate(
  value: string | null | undefined,
  steamId?: number | null,
  rawgId?: number | null,
): string {
  const normalized = normalizeSlugCandidate(value ?? '');
  if (normalized) {
    return normalized.slice(0, MAX_SLUG_LENGTH);
  }

  if (steamId && steamId > 0) return `steam-${steamId}`;
  if (rawgId && rawgId > 0) return `rawg-${rawgId}`;
  return 'game';
}

function ensureUniqueSlug(
  baseCandidate: string,
  set: Set<string>,
  reservedLower: string | null,
): string {
  const base = baseCandidate.trim() || 'game';
  let candidate = base;
  let suffix = 2;

  while (true) {
    const lower = candidate.toLowerCase();
    if (!set.has(lower) || lower === reservedLower) {
      return candidate.slice(0, MAX_SLUG_LENGTH);
    }

    const suffixText = String(suffix++);
    const maxBaseLength = Math.max(1, MAX_SLUG_LENGTH - suffixText.length - 1);
    const trimmedBase = base.length > maxBaseLength ? base.slice(0, maxBaseLength) : base;
    candidate = `${trimmedBase}-${suffixText}`;

    if (suffix > 9999) {
      const fallback = `${trimmedBase}-${Date.now()}`.slice(0, MAX_SLUG_LENGTH);
      return fallback;
    }
  }
}

async function performUpdates(
  dataSource: DataSource,
  updates: SlugUpdate[],
  chunkSize: number,
): Promise<void> {
  console.log(`🛠️ DB 업데이트 시작 (changed=${updates.length}, chunk=${chunkSize})`);

  for (let start = 0; start < updates.length; start += chunkSize) {
    const batch = updates.slice(start, Math.min(start + chunkSize, updates.length));

    for (const item of batch) {
      await dataSource.manager.query(
        `UPDATE public.games
         SET slug = $1,
             og_slug = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [item.slug, item.ogSlug, item.id],
      );
      console.log(
        `${item.logPrefix} ✅ 업데이트 완료 slug: ${item.oldSlug} → ${item.slug}, og_slug: ${item.oldOgSlug} → ${item.ogSlug}`,
      );
    }
  }
}
