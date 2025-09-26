export const STEAM_API = {
  APPDETAILS_URL: 'https://store.steampowered.com/api/appdetails',
  APPLIST_URL: 'https://api.steampowered.com/ISteamApps/GetAppList/v2/',
  DEFAULT_TIMEOUT: 10000,
  DLC_TIMEOUT: 5000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
} as const;

export const RAWG_API = {
  DEFAULT_TIMEOUT: 10000,
  DETAILS_TIMEOUT: 15000,
  STORES_TIMEOUT: 5000,
} as const;
