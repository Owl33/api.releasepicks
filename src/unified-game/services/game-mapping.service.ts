import { Injectable } from '@nestjs/common';

import {
  GameCalendarData,
  RawgCollectedGame,
} from '../../types/game-calendar-unified.types';
import { GameCalendarSteamData } from '../../types/steam.types';
import { DataMapper } from '../persistence/mappers/data.mapper';

/**
 * RAWG/Steam 데이터를 GameCalendarData 구조에 맞게 매핑하는 책임 전용 서비스
 */
@Injectable()
export class GameMappingService {
  createFromRawg(collected: RawgCollectedGame): GameCalendarData {
    const baseData = DataMapper.mapRawgGameToBaseData(
      collected.base,
      collected.detail,
      collected.stores,
      collected.media,
      collected.steamStoreUrl,
      Array.isArray(collected.parentHints)
        ? collected.parentHints
            .map((parent) => (parent && typeof parent.id === 'number' ? parent.id : null))
            .filter((id): id is number => id !== null)
        : null,
    );

    return baseData;
  }

  mergeWithSteam(
    baseData: GameCalendarData,
    steamData: GameCalendarSteamData,
  ): GameCalendarData {
    const merged = DataMapper.mergeWithSteamData(
      baseData,
      steamData,
      steamData.review_summary,
    );

    return {
      ...merged,
      store_links: {
        ...merged.store_links,
        steam: steamData.store_url || merged.store_links?.steam,
      },
    };
  }
}
