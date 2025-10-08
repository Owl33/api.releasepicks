import { normalizeGameName } from './game-name-normalizer.util';

describe('normalizeGameName', () => {
  describe('🔤 그리스 문자 정규화', () => {
    it('Δ (델타) → delta로 변환', () => {
      expect(normalizeGameName('METAL GEAR SOLID Δ: SNAKE EATER')).toBe(
        'metal-gear-solid-delta-snake-eater',
      );
    });

    it('Ω (오메가) → omega로 변환', () => {
      expect(normalizeGameName('Omega Ω Protocol')).toBe('omega-omega-protocol');
    });

    it('Α (알파) → alpha로 변환', () => {
      expect(normalizeGameName('Alpha Α Centauri')).toBe('alpha-alpha-centauri');
    });

    it('Σ (시그마) → sigma로 변환', () => {
      expect(normalizeGameName('Sigma Σ Theory')).toBe('sigma-sigma-theory');
    });

    it('여러 그리스 문자 동시 변환', () => {
      expect(normalizeGameName('Α to Ω Journey')).toBe('alpha-to-omega-journey');
    });
  });

  describe('🔢 로마 숫자 정규화', () => {
    it('Ⅶ (7) → 7로 변환', () => {
      expect(normalizeGameName('Final Fantasy Ⅶ Remake')).toBe(
        'final-fantasy-7-remake',
      );
    });

    it('Ⅰ (1) → 1로 변환', () => {
      expect(normalizeGameName('Dragon Quest Ⅰ')).toBe('dragon-quest-1');
    });

    it('Ⅲ (3) → 3로 변환', () => {
      expect(normalizeGameName('Dark Souls Ⅲ')).toBe('dark-souls-3');
    });

    it('Ⅻ (12) → 12로 변환', () => {
      expect(normalizeGameName('Final Fantasy Ⅻ')).toBe('final-fantasy-12');
    });
  });

  describe('™️ 상표/저작권 기호 제거', () => {
    it('™ 제거', () => {
      expect(normalizeGameName('Game Title™')).toBe('game-title');
    });

    it('® 제거', () => {
      expect(normalizeGameName('Brand®')).toBe('brand');
    });

    it('© 제거', () => {
      expect(normalizeGameName('©2024 Game')).toBe('2024-game');
    });

    it('여러 상표 기호 동시 제거', () => {
      expect(normalizeGameName('Title™ Brand® ©2024')).toBe('title-brand-2024');
    });
  });

  describe('📐 기타 특수 기호 처리', () => {
    it('№ → no로 변환', () => {
      expect(normalizeGameName('Item №5')).toBe('item-no5');
    });

    it('불릿 포인트 제거', () => {
      expect(normalizeGameName('Game • Edition')).toBe('game-edition');
    });

    it('말줄임표 제거', () => {
      expect(normalizeGameName('Title…')).toBe('title');
    });

    it('en/em dash → 하이픈 변환', () => {
      expect(normalizeGameName('Game – Edition')).toBe('game-edition');
      expect(normalizeGameName('Game — Edition')).toBe('game-edition');
    });
  });

  describe('🌍 실제 사용 시나리오 (Steam vs RAWG)', () => {
    it('Metal Gear Solid Δ - Steam과 RAWG가 동일한 slug 생성', () => {
      const steamName = 'METAL GEAR SOLID Δ: SNAKE EATER';
      const rawgName = 'Metal Gear Solid Delta: Snake Eater';

      const steamSlug = normalizeGameName(steamName);
      const rawgSlug = normalizeGameName(rawgName);

      expect(steamSlug).toBe('metal-gear-solid-delta-snake-eater');
      expect(rawgSlug).toBe('metal-gear-solid-delta-snake-eater');
      expect(steamSlug).toBe(rawgSlug); // ⭐ 중복 방지 확인
    });

    it('Final Fantasy Ⅶ Remake - 로마 숫자 통일', () => {
      const variant1 = 'Final Fantasy Ⅶ Remake™';
      const variant2 = 'Final Fantasy 7 Remake';

      const slug1 = normalizeGameName(variant1);
      const slug2 = normalizeGameName(variant2);

      expect(slug1).toBe('final-fantasy-7-remake');
      expect(slug2).toBe('final-fantasy-7-remake');
      expect(slug1).toBe(slug2);
    });
  });

  describe('🛡️ 엣지 케이스', () => {
    it('빈 문자열 처리', () => {
      expect(normalizeGameName('')).toBe('');
    });

    it('null/undefined 처리', () => {
      expect(normalizeGameName(null as any)).toBe('');
      expect(normalizeGameName(undefined as any)).toBe('');
    });

    it('특수문자만 있는 경우', () => {
      expect(normalizeGameName('™®©')).toBe('');
    });

    it('연속 공백 처리', () => {
      expect(normalizeGameName('Game    Title')).toBe('game-title');
    });

    it('연속 하이픈 제거', () => {
      expect(normalizeGameName('Game---Title')).toBe('game-title');
    });

    it('앞뒤 하이픈 제거', () => {
      expect(normalizeGameName('-Game-')).toBe('game');
    });

    it('100자 초과 시 잘림', () => {
      const longName = 'a'.repeat(150);
      const slug = normalizeGameName(longName);
      expect(slug.length).toBe(100);
    });
  });

  describe('🌏 다국어 지원', () => {
    it('한글 게임 이름', () => {
      expect(normalizeGameName('바람의나라 Ⅱ')).toBe('바람의나라-2');
    });

    it('일본어 게임 이름 (히라가나)', () => {
      expect(normalizeGameName('ファイナルファンタジーⅦ')).toBe(
        'ファイナルファンタジー7',
      );
    });

    it('일본어 게임 이름 (한자)', () => {
      expect(normalizeGameName('龍が如く Ω')).toBe('龍が如く-omega');
    });

    it('영문+한글 혼용', () => {
      expect(normalizeGameName('Black Desert 검은사막™')).toBe(
        'black-desert-검은사막',
      );
    });
  });
});
