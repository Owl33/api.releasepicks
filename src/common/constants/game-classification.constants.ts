export const GAME_KEYWORDS = {
  DLC: [
    'dlc',
    'expansion',
    'season pass',
    'episode',
    'pack',
    'content pack',
    'add-on',
    'downloadable content',
    'addon',
    'chapter',
    'extra content',
  ] as const,
  EDITION: [
    'remaster',
    'remastered',
    'definitive edition',
    'complete edition',
    "director's cut",
    'anniversary edition',
    'ultimate edition',
    'deluxe edition',
    'goty',
    'game of the year',
    'enhanced edition',
    'gold edition',
    'premium edition',
    'special edition',
    "collector's edition",
    'legendary edition',
    'royal edition',
    'platinum edition',
  ] as const,
  PORT: [
    'pc port',
    'pc version',
    'steam edition',
    'console edition',
    'windows edition',
    'steam version',
    'desktop',
    'hd collection',
    'trilogy',
  ] as const,
} as const;

export const GAME_TYPES = {
  MAIN_GAME: 'main_game',
  DLC: 'dlc',
  EDITION: 'edition',
  PORT: 'port',
  STANDALONE: 'standalone',
} as const;

export type GameType = (typeof GAME_TYPES)[keyof typeof GAME_TYPES];

export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.9,
  MEDIUM: 0.7,
  LOW: 0.5,
  SIMILARITY: 0.7,
} as const;

export const PERFORMANCE_LIMITS = {
  MAX_DLC_LIST_SIZE: 20,
  MAX_SEARCH_STRATEGIES: 5,
  CACHE_DURATION: 60 * 60 * 1000,
  DLC_CHECK_MAX_COUNT: 50,
  SIMILARITY_CALCULATION_LIMIT: 100,
} as const;
