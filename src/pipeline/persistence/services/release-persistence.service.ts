import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, FindOptionsWhere } from 'typeorm';

import { GameReleaseData } from '@pipeline/contracts';

import { GameRelease } from '../../../entities/game-release.entity';

/**
 * ReleasePersistenceService
 * - 게임 릴리스 저장/업데이트 책임 전담
 */
@Injectable()
export class ReleasePersistenceService {
  private readonly logger = new Logger(ReleasePersistenceService.name);

  async syncGameReleases(
    gameId: number,
    releases: GameReleaseData[],
    manager: EntityManager,
  ): Promise<void> {
    for (const releaseData of releases) {
      const storeAppId = this.normalizeStoreAppId(releaseData.storeAppId);
      const where: FindOptionsWhere<GameRelease> = {
        game_id: gameId,
        platform: releaseData.platform,
        store: releaseData.store,
        store_app_id: storeAppId,
      };

      const existingRelease = await manager.findOne(GameRelease, { where });
      if (releaseData.dataSource === 'rawg' && releaseData.platform === 'pc') {
        this.logger.warn(
          `RAWG 릴리스(플랫폼=pc)를 스킵합니다: gameId=${gameId}, store=${releaseData.store}, appId=${releaseData.storeAppId}`,
        );
        continue;
      }

      if (existingRelease) {
        await manager.update(GameRelease, existingRelease.id, {
          store_url: releaseData.storeUrl,
          release_date_date: releaseData.releaseDateDate,
          release_date_raw: releaseData.releaseDateRaw,
          release_status: releaseData.releaseStatus,
          coming_soon: releaseData.comingSoon,
          current_price_cents: releaseData.currentPriceCents ?? null,
          is_free: releaseData.isFree,
          followers: releaseData.followers ?? null,
          reviews_total: releaseData.reviewsTotal ?? null,
          review_score_desc: releaseData.reviewScoreDesc ?? null,
          store_app_id: storeAppId,
          updated_at: new Date(),
        });
      } else {
        const release = manager.create(GameRelease, {
          game_id: gameId,
          platform: releaseData.platform,
          store: releaseData.store,
          store_app_id: storeAppId,
          store_url: releaseData.storeUrl,
          release_date_date: releaseData.releaseDateDate,
          release_date_raw: releaseData.releaseDateRaw,
          release_status: releaseData.releaseStatus,
          coming_soon: releaseData.comingSoon,
          current_price_cents: releaseData.currentPriceCents ?? null,
          is_free: releaseData.isFree,
          followers: releaseData.followers ?? null,
          reviews_total: releaseData.reviewsTotal ?? null,
          review_score_desc: releaseData.reviewScoreDesc ?? null,
          data_source: releaseData.dataSource,
        });

        await manager.save(GameRelease, release);
      }
    }
  }

  private normalizeStoreAppId(storeAppId?: string | number | null): string {
    if (storeAppId === undefined || storeAppId === null) {
      return '';
    }

    const normalized = String(storeAppId).trim();
    return normalized || '';
  }
}
