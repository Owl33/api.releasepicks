import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Game } from '../../../entities/game.entity';
import { ExistingGamesMap } from '@pipeline/contracts';

type PriorityBucketSizes = {
  latest: number;
  soon: number;
  popular: number;
};

@Injectable()
export class ExistingGamesSnapshotService {
  constructor(
    @InjectRepository(Game)
    private readonly gameRepository: Repository<Game>,
  ) {}

  /**
   * 우선순위 선별 버킷 기반으로 기존 게임 스냅샷을 로드한다.
   * - 최신, 출시임박, 인기 버킷을 각각 조회해 Map으로 병합한다.
   */
  async loadPriorityBuckets(
    bucketSizes: PriorityBucketSizes,
  ): Promise<ExistingGamesMap> {
    const buffer = Math.max(
      50,
      Number(process.env.STEAM_EXISTING_BUFFER ?? '150'),
    );
    const selectColumns: (keyof Game)[] = [
      'steam_id',
      'coming_soon',
      'release_date_date',
      'followers_cache',
      'popularity_score',
    ];

    const map: ExistingGamesMap = new Map();

    const attach = (game: Game): void => {
      if (!game.steam_id) return;
      map.set(game.steam_id, {
        steam_id: game.steam_id,
        coming_soon: game.coming_soon,
        release_date_date: game.release_date_date ?? null,
        followers_cache: game.followers_cache ?? null,
        popularity_score: game.popularity_score ?? null,
      });
    };

    const latestRows = await this.gameRepository
      .createQueryBuilder('g')
      .select(selectColumns.map((col) => `g.${String(col)}`))
      .where('g.steam_id IS NOT NULL')
      .orderBy('g.steam_id', 'DESC')
      .limit(bucketSizes.latest + buffer)
      .getMany();
    latestRows.forEach(attach);

    const comingSoonRows = await this.gameRepository
      .createQueryBuilder('g')
      .select(selectColumns.map((col) => `g.${String(col)}`))
      .where('g.steam_id IS NOT NULL')
      .andWhere('g.coming_soon = :comingSoon', { comingSoon: true })
      .orderBy('g.release_date_date', 'ASC')
      .limit(bucketSizes.soon + buffer)
      .getMany();
    comingSoonRows.forEach(attach);

    const popularRows = await this.gameRepository
      .createQueryBuilder('g')
      .select(selectColumns.map((col) => `g.${String(col)}`))
      .where('g.steam_id IS NOT NULL')
      .andWhere('COALESCE(g.followers_cache, 0) > :threshold', {
        threshold: Number(
          process.env.STEAM_POPULAR_FOLLOWERS_THRESHOLD ?? '1000',
        ),
      })
      .orderBy('g.followers_cache', 'DESC')
      .limit(bucketSizes.popular + buffer)
      .getMany();
    popularRows.forEach(attach);

    return map;
  }

  /**
   * 특정 Steam AppID 목록에 해당하는 기존 게임 정보를 로드한다.
   */
  async loadBySteamIds(steamIds: number[]): Promise<ExistingGamesMap> {
    if (steamIds.length === 0) {
      return new Map();
    }

    const rows = await this.gameRepository.find({
      where: { steam_id: In(steamIds) },
      select: [
        'steam_id',
        'coming_soon',
        'release_date_date',
        'followers_cache',
        'popularity_score',
      ],
    });

    const map: ExistingGamesMap = new Map();
    rows.forEach((game) => {
      if (!game.steam_id) return;
      map.set(game.steam_id, {
        steam_id: game.steam_id,
        coming_soon: game.coming_soon,
        release_date_date: game.release_date_date ?? null,
        followers_cache: game.followers_cache ?? null,
        popularity_score: game.popularity_score ?? null,
      });
    });

    return map;
  }
}
