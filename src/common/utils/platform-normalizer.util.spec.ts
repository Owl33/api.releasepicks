/**
 * platform-normalizer 유틸리티 단위 테스트
 * Phase 2: RAWG 플랫폼 정규화 검증
 */

import {
  normalizePlatformSlug,
  normalizePlatforms,
  PlatformFamily,
} from './platform-normalizer.util';

describe('platform-normalizer', () => {
  describe('normalizePlatformSlug', () => {
    it('PlayStation 세대명을 "playstation" 패밀리로 정규화', () => {
      expect(normalizePlatformSlug('playstation5')).toBe('playstation');
      expect(normalizePlatformSlug('playstation4')).toBe('playstation');
      expect(normalizePlatformSlug('playstation3')).toBe('playstation');
      expect(normalizePlatformSlug('PlayStation5')).toBe('playstation'); // 대소문자 무관
      expect(normalizePlatformSlug('PLAYSTATION4')).toBe('playstation');
    });

    it('Xbox 세대명을 "xbox" 패밀리로 정규화', () => {
      expect(normalizePlatformSlug('xbox-series-x')).toBe('xbox');
      expect(normalizePlatformSlug('xbox-one')).toBe('xbox');
      expect(normalizePlatformSlug('xbox360')).toBe('xbox');
      expect(normalizePlatformSlug('Xbox-Series-X')).toBe('xbox'); // 대소문자 무관
      expect(normalizePlatformSlug('XBOX-ONE')).toBe('xbox');
    });

    it('Nintendo 세대명을 "nintendo" 패밀리로 정규화', () => {
      expect(normalizePlatformSlug('nintendo-switch')).toBe('nintendo');
      expect(normalizePlatformSlug('Nintendo-Switch')).toBe('nintendo'); // 대소문자 무관
      expect(normalizePlatformSlug('NINTENDO-SWITCH')).toBe('nintendo');
    });

    it('PC를 "pc"로 정규화', () => {
      expect(normalizePlatformSlug('pc')).toBe('pc');
      expect(normalizePlatformSlug('PC')).toBe('pc');
    });

    it('지원하지 않는 플랫폼은 null 반환', () => {
      expect(normalizePlatformSlug('android')).toBeNull();
      expect(normalizePlatformSlug('ios')).toBeNull();
      expect(normalizePlatformSlug('macos')).toBeNull();
      expect(normalizePlatformSlug('linux')).toBeNull();
      expect(normalizePlatformSlug('')).toBeNull();
      expect(normalizePlatformSlug('unknown-platform')).toBeNull();
    });

    it('공백 및 특수문자 처리', () => {
      expect(normalizePlatformSlug('  playstation5  ')).toBe('playstation'); // 앞뒤 공백
      expect(normalizePlatformSlug('xbox-series-x')).toBe('xbox'); // 하이픈 포함
    });
  });

  describe('normalizePlatforms', () => {
    it('여러 플랫폼을 정규화하고 중복 제거', () => {
      const platforms = [
        { platform: { slug: 'playstation5' } },
        { platform: { slug: 'playstation4' } },
        { platform: { slug: 'xbox-series-x' } },
        { platform: { slug: 'nintendo-switch' } },
      ];

      const result = normalizePlatforms(platforms);

      expect(result).toHaveLength(3);
      expect(result).toContain('playstation');
      expect(result).toContain('xbox');
      expect(result).toContain('nintendo');
    });

    it('동일 패밀리 중복 제거 (PS5 + PS4 → playstation 1개)', () => {
      const platforms = [
        { platform: { slug: 'playstation5' } },
        { platform: { slug: 'playstation4' } },
      ];

      const result = normalizePlatforms(platforms);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe('playstation');
    });

    it('빈 배열 입력 시 빈 배열 반환', () => {
      expect(normalizePlatforms([])).toEqual([]);
    });

    it('지원하지 않는 플랫폼 필터링', () => {
      const platforms = [
        { platform: { slug: 'playstation5' } },
        { platform: { slug: 'android' } }, // 필터링됨
        { platform: { slug: 'ios' } }, // 필터링됨
        { platform: { slug: 'xbox-one' } },
      ];

      const result = normalizePlatforms(platforms);

      expect(result).toHaveLength(2);
      expect(result).toContain('playstation');
      expect(result).toContain('xbox');
      expect(result).not.toContain('android' as PlatformFamily);
      expect(result).not.toContain('ios' as PlatformFamily);
    });

    it('모든 플랫폼 패밀리 정규화 (PlayStation + Xbox + Nintendo + PC)', () => {
      const platforms = [
        { platform: { slug: 'playstation5' } },
        { platform: { slug: 'xbox-series-x' } },
        { platform: { slug: 'nintendo-switch' } },
        { platform: { slug: 'pc' } },
      ];

      const result = normalizePlatforms(platforms);

      expect(result).toHaveLength(4);
      expect(result).toContain('playstation');
      expect(result).toContain('xbox');
      expect(result).toContain('nintendo');
      expect(result).toContain('pc');
    });
  });
});
