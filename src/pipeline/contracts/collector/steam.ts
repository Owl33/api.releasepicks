import { ExistingGamesMap } from './shared';

export interface PrioritySelectionOptions {
  limit: number;
  mode: 'bootstrap' | 'operational';
  existingGames?: ExistingGamesMap;
}

export interface SteamCollectOptions {
  mode: 'bootstrap' | 'operational';
  limit: number;
  strategy?: 'latest' | 'priority';
}

export interface SteamRefreshCandidate {
  gameId: number;
  steamId: number;
  name: string;
  slug: string;
}
