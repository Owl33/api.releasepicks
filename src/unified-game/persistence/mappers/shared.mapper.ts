import { PlatformType } from '../../../types/domain.types';

export class SharedMapper {
  static normalizeScreenshots(screenshots: any): string[] {
    if (!screenshots) return [];
    if (Array.isArray(screenshots)) {
      return screenshots
        .map((s) => {
          if (typeof s === 'string') return s;
          if (s && typeof s === 'object') {
            return s.image || s.path_full || s.url || String(s);
          }
          return String(s);
        })
        .filter(Boolean);
    }
    return [];
  }

  static normalizeStringArray(values: any, limit?: number): string[] {
    if (!Array.isArray(values)) {
      return [];
    }
    const normalized = values.map((value) => String(value));
    const sliced = limit ? normalized.slice(0, limit) : normalized;
    return sliced;
  }

  static normalizeNumberArray(values: any): number[] {
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map((value) => Number(value)).filter((value) => !Number.isNaN(value));
  }

  static normalizeObject(obj: Record<string, unknown>): Record<string, unknown> {
    const entries = Object.entries(obj || {})
      .filter(([_, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.reduce<Record<string, unknown>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
  }

  static normalizeSteamFullgameInfo(
    fullgameInfo: unknown,
  ): { [key: string]: unknown; appid?: string; name?: string } | null {
    if (!fullgameInfo || typeof fullgameInfo !== 'object' || Array.isArray(fullgameInfo)) {
      return null;
    }

    const normalized: Record<string, unknown> = {};

    for (const [key, rawValue] of Object.entries(fullgameInfo)) {
      if (rawValue === undefined || rawValue === null) {
        continue;
      }

      if (key === 'appid' || key === 'name') {
        normalized[key] = String(rawValue);
        continue;
      }

      normalized[key] = rawValue;
    }

    if (Object.keys(normalized).length === 0) {
      return null;
    }

    return normalized as { [key: string]: unknown; appid?: string; name?: string };
  }

  static normalizeRawgTags(tags: any[]): string[] {
    if (!Array.isArray(tags)) return [];
    return tags
      .filter((tag: any) => tag?.language === 'eng')
      .map((tag: any) => tag?.name)
      .filter(Boolean)
      .slice(0, 10);
  }

  static normalizeSteamCategories(categories: any[]): string[] {
    if (!Array.isArray(categories)) return [];

    return categories
      .map((cat: any) => {
        if (typeof cat === 'string') return cat;
        return cat?.description || '';
      })
      .filter(Boolean);
  }

  static normalizePlatforms(platforms: any[]): string[] {
    if (!Array.isArray(platforms)) return [];
    return platforms
      .map((p) => {
        const slug = p?.platform?.slug || p?.platform || p;
        return typeof slug === 'string' ? slug : '';
      })
      .filter(Boolean);
  }

  static determinePlatformType(platforms: string[]): PlatformType {
    const lower = platforms.map((p) => p.toLowerCase());
    const hasPc = lower.some((p) => ['pc', 'windows', 'macos', 'linux'].some((os) => p.includes(os)));
    const hasConsole = lower.some((p) =>
      ['playstation', 'xbox', 'nintendo', 'switch'].some((console) =>
        p.includes(console),
      ),
    );

    if (hasPc && hasConsole) return 'mixed';
    if (hasConsole) return 'console';
    return 'pc';
  }
}
