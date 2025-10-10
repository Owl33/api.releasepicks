import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import slugify from 'slugify';

import { Game } from '../../../entities/game.entity';
import {
  ResolvedSlug,
  SlugContext,
  SlugPolicyPort,
} from './slug-policy.interface';

/**
 * SlugPolicyService
 * - 공통 slug/og_slug 생성 규칙을 담당한다.
 * - 별도의 Registry 테이블 없이 기존 엔티티 컬럼의 UNIQUE 제약을 활용한다.
 */
@Injectable()
export class SlugPolicyService implements SlugPolicyPort {
  private readonly logger = new Logger(SlugPolicyService.name);

  async resolve(
    manager: EntityManager,
    context: SlugContext,
  ): Promise<ResolvedSlug> {
    const slugBase = this.buildCandidate(
      context.preferredSlug ?? context.name,
      context.fallbackSteamId,
      context.fallbackRawgId,
    );
    const ogBase = this.buildCandidate(
      context.preferredOgSlug ?? context.ogName ?? context.name,
      context.fallbackSteamId,
      context.fallbackRawgId,
    );

    const slug = await this.ensureUnique(
      manager,
      slugBase,
      context.selfId,
      'slug',
    );
    const ogSlug = await this.ensureUnique(
      manager,
      ogBase,
      context.selfId,
      'og_slug',
    );

    if (context.preferredSlug && context.preferredSlug !== slug) {
      this.logger.verbose(
        `Slug 변경: ${context.preferredSlug} -> ${slug} (id=${context.selfId ?? 'new'})`,
      );
    }
    if (context.preferredOgSlug && context.preferredOgSlug !== ogSlug) {
      this.logger.verbose(
        `OG Slug 변경: ${context.preferredOgSlug} -> ${ogSlug} (id=${context.selfId ?? 'new'})`,
      );
    }

    return { slug, ogSlug };
  }

  private buildCandidate(
    value: string | null | undefined,
    steamId?: number | null,
    rawgId?: number | null,
  ): string {
    if (value) {
      const normalized = this.normalize(value);
      if (normalized) return normalized;
    }

    if (steamId) return `game-${steamId}`;
    if (rawgId) return `game-${rawgId}`;
    return 'game';
  }

  private normalize(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const base = slugify(trimmed, {
      lower: true,
      strict: false,
      locale: 'ko',
      remove: /[^a-zA-Z0-9가-힣\s-]/g,
      replacement: '-',
      trim: true,
    })
      .replace(/[^a-z0-9가-힣\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!base) return null;
    return base.slice(0, 120);
  }

  private async ensureUnique(
    manager: EntityManager,
    candidate: string,
    selfId: number | null,
    column: 'slug' | 'og_slug',
  ): Promise<string> {
    let current = candidate.trim();
    if (!current) current = 'game';

    let suffix = 2;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const exists = await manager
        .createQueryBuilder(Game, 'game')
        .where(`LOWER(game.${column}) = LOWER(:slug)`, { slug: current })
        .andWhere(selfId ? 'game.id <> :selfId' : '1=1', { selfId })
        .getExists();

      if (!exists) return current;

      const suffixText = String(suffix++);
      const maxBaseLength = Math.max(1, 120 - suffixText.length - 1);
      const trimmedBase = candidate.length > maxBaseLength
        ? candidate.slice(0, maxBaseLength)
        : candidate;

      current = `${trimmedBase}-${suffixText}`;
      if (suffix > 9999) {
        this.logger.warn(
          `Slug 고유값 확보 실패: candidate=${candidate}, column=${column}`,
        );
        return `${trimmedBase}-${Date.now()}`;
      }
    }
  }
}
