import {
  mapRawgPlatformSlugToPlatform,
  summarizeRawgPlatforms,
} from '../platform-mapper.util';
import { Platform } from '../../../entities/enums';

describe('platform-mapper', () => {
  it('RAWG slug를 통합 플랫폼으로 매핑한다', () => {
    expect(mapRawgPlatformSlugToPlatform('playstation5')).toBe(
      Platform.PLAYSTATION,
    );
    expect(mapRawgPlatformSlugToPlatform('nintendo-switch')).toBe(
      Platform.NINTENDO,
    );
  });

  it('플랫폼 요약을 반환한다', () => {
    const summary = summarizeRawgPlatforms(['pc', 'playstation4', 'xbox-one']);
    expect(summary.pc).toBe(true);
    expect(summary.consoles).toContain(Platform.PLAYSTATION);
    expect(summary.consoles).toContain(Platform.XBOX);
  });
});
