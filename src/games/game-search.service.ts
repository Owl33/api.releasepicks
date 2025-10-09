// src/modules/game/game-search.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
import {
  SearchGamesDto,
  SearchGameDto,
  SearchResponseDto,
} from './dto/search.dto';

@Injectable()
export class GameSearchService {
  constructor(
    @InjectRepository(Game) private readonly gameRepo: Repository<Game>,
    @InjectRepository(GameDetail)
    private readonly detailRepo: Repository<GameDetail>,
  ) {}

  private slugifyLoose(s: string): string {
    // "elden  -  ring" -> "elden-ring", "gta5" 그대로(후처리에서 경계 하이픈만 선택적 추가)
    return s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u3131-\uD79D\s\-_]+/g, '') // 영문/숫자/한글/공백/하이픈/언더스코어만
      .replace(/[\s_]+/g, '-') // 공백/언더스코어 -> 하이픈
      .replace(/\-+/g, '-')
      .replace(/^\-|\-$/g, '');
  }

  private compact(s: string): string {
    // 공백/하이픈/언더스코어 제거 → "eldenring"
    return s
      .toLowerCase()
      .replace(/[\s\-_]+/g, '')
      .trim();
  }

  private isSluggyAscii(s: string): boolean {
    // 영문/숫자/공백/하이픈만 → 슬러그 검색 활성화
    const hasCJK = /[\u3131-\uD79D]/.test(s);
    const asciiLike = /^[a-z0-9\-\s_]+$/i.test(s);
    return asciiLike && !hasCJK;
  }

  async searchGames(dto: SearchGamesDto): Promise<SearchResponseDto> {
    const rawQ = (dto.q ?? '').trim();
    const limit = Math.min(Math.max(dto.limit ?? 10, 1), 50);

    if (rawQ.length < 2) {
      return { query: rawQ, count: 0, data: [] }; // 200 + 빈 결과
    }

    const qLower = rawQ.toLowerCase();
    const len = qLower.length;
    const prefixOnly = len <= 2;

    const useSlug = this.isSluggyAscii(qLower);
    const qSlug = useSlug ? this.slugifyLoose(qLower) : '';
    const qCompact = this.compact(qLower); // "elden - rig" -> "eldenrig"
    const qPrefix = `${qLower}%`;
    const qLike = `%${qLower}%`;

    const NAME_MIN = len >= 8 ? 0.35 : len >= 5 ? 0.3 : 0.27;
    const SLUG_MIN = len >= 8 ? 0.3 : len >= 5 ? 0.26 : 0.22;

    const qb = this.gameRepo
      .createQueryBuilder('game')
      .innerJoin('game.details', 'detail', 'detail.sexual = false')
      .select([
        'game.id AS game_id',
        'game.name AS game_name',
        'game.slug AS game_slug',
        'game.release_date_date AS release_date',
        'game.popularity_score AS popularity_score',
        'game.followers_cache AS followers_cache',
        'detail.header_image AS header_image',
      ])
      .where('game.popularity_score >= :minScore', { minScore: 40 });

    // ① 후보 축소 — 반드시 인덱스를 타는 식만 사용
    qb.andWhere(
      new Brackets((b) => {
        if (prefixOnly) {
          // 너무 짧으면 prefix만
          b.where('lower(game.name) LIKE :qPrefix', { qPrefix }).orWhere(
            'lower(game.og_name) LIKE :qPrefix',
            { qPrefix },
          );

          // compact prefix는 과도 추출될 수 있어 제외
          if (useSlug) {
            b.orWhere('(game.slug::text) LIKE :qSlugPrefix', {
              qSlugPrefix: `${qSlug}%`,
            }).orWhere('(game.og_slug::text) LIKE :qSlugPrefix', {
              qSlugPrefix: `${qSlug}%`,
            });
          }
        } else {
          // trigram + compact trigram (인덱스 존재)
          b.where('lower(game.name) % :qLower', { qLower })
            .orWhere('lower(game.og_name) % :qLower', { qLower })
            .orWhere(
              "regexp_replace(lower(game.name), '[\\s\\-_/]+', '', 'g') % :qCompact",
              { qCompact },
            )
            .orWhere(
              "regexp_replace(lower(game.og_name), '[\\s\\-_/]+', '', 'g') % :qCompact",
              { qCompact },
            );

          if (useSlug) {
            b.orWhere('(game.slug::text) % :qSlug', { qSlug })
              .orWhere('(game.og_slug::text) % :qSlug', { qSlug })
              .orWhere(
                "regexp_replace((game.slug::text), '[\\s\\-_/]+', '', 'g') % :qCompact",
                { qCompact },
              )
              .orWhere(
                "regexp_replace((game.og_slug::text), '[\\s\\-_/]+', '', 'g') % :qCompact",
                { qCompact },
              );
          }
        }
      }),
    );

    // ② 랭킹 계산 — exact/prefix/부분/compact/slug + trigram + popularity
    qb.addSelect(
      `
      (
        1.25 * (
          CASE
            WHEN lower(game.name) = :qLower THEN 1.00
            WHEN lower(game.name) LIKE :qPrefix THEN 0.92
            WHEN lower(game.name) LIKE :qLike   THEN 0.40
            ELSE 0.00
          END
        )
        + 1.05 * (
          CASE
            WHEN lower(game.og_name) = :qLower THEN 0.95
            WHEN lower(game.og_name) LIKE :qPrefix THEN 0.72
            WHEN lower(game.og_name) LIKE :qLike   THEN 0.35
            ELSE 0.00
          END
        )
        + 0.95 * similarity(lower(game.name), :qLower)
        + 0.65 * similarity(lower(game.og_name), :qLower)
        + 0.70 * similarity(
            regexp_replace(lower(game.name), '[\\s\\-_/]+', '', 'g'),
            :qCompact
          )
        + 0.50 * similarity(
            regexp_replace(lower(game.og_name), '[\\s\\-_/]+', '', 'g'),
            :qCompact
          )
        ${
          useSlug
            ? `
        + 1.05 * (
          CASE
            WHEN (game.slug::text) = :qSlug THEN 0.98
            WHEN (game.slug::text) LIKE :qSlugPrefix THEN 0.80
            WHEN (game.slug::text) LIKE :qSlugLike   THEN 0.30
            ELSE 0.00
          END
        )
        + 0.95 * (
          CASE
            WHEN (game.og_slug::text) = :qSlug THEN 0.92
            WHEN (game.og_slug::text) LIKE :qSlugPrefix THEN 0.70
            WHEN (game.og_slug::text) LIKE :qSlugLike   THEN 0.25
            ELSE 0.00
          END
        )
        + 0.60 * similarity((game.slug::text), :qSlug)
        + 0.45 * similarity((game.og_slug::text), :qSlug)
        + 0.55 * similarity(
            regexp_replace((game.slug::text), '[\\s\\-_/]+', '', 'g'),
            :qCompact
          )
        + 0.40 * similarity(
            regexp_replace((game.og_slug::text), '[\\s\\-_/]+', '', 'g'),
            :qCompact
          )
        `
            : ``
        }
        + 0.15 * LEAST(GREATEST(game.popularity_score,0),100)/100.0
      )
      `,
      'rank',
    );

    // (짧지 않다면) 유사도 하한 컷
    if (!prefixOnly) {
      qb.andWhere(
        new Brackets((b) => {
          b.where('similarity(lower(game.name), :qLower) >= :NAME_MIN')
            .orWhere('similarity(lower(game.og_name), :qLower) >= :NAME_MIN')
            .orWhere(
              "similarity(regexp_replace(lower(game.name), '[\\s\\-_/]+', '', 'g'), :qCompact) >= :NAME_MIN",
            )
            .orWhere(
              "similarity(regexp_replace(lower(game.og_name), '[\\s\\-_/]+', '', 'g'), :qCompact) >= :NAME_MIN",
            );
          if (useSlug) {
            b.orWhere('similarity((game.slug::text), :qSlug) >= :SLUG_MIN')
              .orWhere('similarity((game.og_slug::text), :qSlug) >= :SLUG_MIN')
              .orWhere(
                "similarity(regexp_replace((game.slug::text), '[\\s\\-_/]+', '', 'g'), :qCompact) >= :SLUG_MIN",
              )
              .orWhere(
                "similarity(regexp_replace((game.og_slug::text), '[\\s\\-_/]+', '', 'g'), :qCompact) >= :SLUG_MIN",
              );
          }
        }),
      );
    }

    qb.orderBy('rank', 'DESC')
      .addOrderBy('game.popularity_score', 'DESC')
      .addOrderBy('game.release_date_date', 'DESC')
      .setParameters({
        qLower,
        qPrefix,
        qLike,
        qCompact,
        ...(useSlug
          ? {
              qSlug,
              qSlugPrefix: `${qSlug}%`,
              qSlugLike: `%${qSlug}%`,
            }
          : {}),
        NAME_MIN,
        SLUG_MIN,
      })
      .limit(limit);

    const rows = await qb.getRawMany();

    const data: SearchGameDto[] = rows.map((r) => ({
      gameId: Number(r.game_id),
      name: String(r.game_name ?? ''),
      slug: String(r.game_slug ?? ''),
      headerImage: r.header_image ?? null,
      releaseDate: r.release_date ? new Date(r.release_date) : null,
      popularityScore: Number(r.popularity_score ?? 0),
      followersCache: r.followers_cache ? Number(r.followers_cache) : null,
      platforms: [],
      developers: [],
      publishers: [],
    }));

    return { query: rawQ, count: data.length, data };
  }
}
