import { PopularityCalculator } from './popularity-calculator.util';

describe('PopularityCalculator', () => {
  describe('calculateSteamPopularity', () => {
    it('should return 94 for 50,000 followers', () => {
      const followers = 50000;
      const result = PopularityCalculator.calculateSteamPopularity(followers);

      // Math.log10(50001) * 20 ≈ 93.98
      expect(result).toBeCloseTo(94, 0);
    });

    it('should return 0 for 0 followers', () => {
      const followers = 0;
      const result = PopularityCalculator.calculateSteamPopularity(followers);

      // Math.log10(1) * 20 = 0
      expect(result).toBe(0);
    });

    it('should return 100 for extremely high followers', () => {
      const followers = 10000000; // 1천만
      const result = PopularityCalculator.calculateSteamPopularity(followers);

      // Math.log10(10000001) * 20 ≈ 140 → capped at 100
      expect(result).toBe(100);
    });

    it('should throw error for negative followers', () => {
      expect(() => {
        PopularityCalculator.calculateSteamPopularity(-100);
      }).toThrow('Followers must be non-negative');
    });
  });

  describe('calculateRawgPopularity', () => {
    it('should return 92 for 5,000 added', () => {
      const added = 5000;
      const result = PopularityCalculator.calculateRawgPopularity(added);

      // Math.log10(5001) * 25 ≈ 92.48
      expect(result).toBeCloseTo(92, 0);
    });

    it('should return 0 for 0 added', () => {
      const added = 0;
      const result = PopularityCalculator.calculateRawgPopularity(added);

      // Math.log10(1) * 25 = 0
      expect(result).toBe(0);
    });

    it('should return 100 for extremely high added count', () => {
      const added = 1000000; // 100만
      const result = PopularityCalculator.calculateRawgPopularity(added);

      // Math.log10(1000001) * 25 ≈ 150 → capped at 100
      expect(result).toBe(100);
    });

    it('should throw error for negative added count', () => {
      expect(() => {
        PopularityCalculator.calculateRawgPopularity(-100);
      }).toThrow('Added count must be non-negative');
    });
  });

  describe('calculateMixedPopularity', () => {
    it('should return 93.6 for steam=94, rawg=92', () => {
      const steamScore = 94;
      const rawgScore = 92;
      const result = PopularityCalculator.calculateMixedPopularity(
        steamScore,
        rawgScore,
      );

      // 94 * 0.8 + 92 * 0.2 = 75.2 + 18.4 = 93.6
      expect(result).toBeCloseTo(93.6, 1);
    });

    it('should return steam score when rawg=0', () => {
      const steamScore = 80;
      const rawgScore = 0;
      const result = PopularityCalculator.calculateMixedPopularity(
        steamScore,
        rawgScore,
      );

      // 80 * 0.8 + 0 * 0.2 = 64
      expect(result).toBe(64);
    });

    it('should return rawg contribution when steam=0', () => {
      const steamScore = 0;
      const rawgScore = 50;
      const result = PopularityCalculator.calculateMixedPopularity(
        steamScore,
        rawgScore,
      );

      // 0 * 0.8 + 50 * 0.2 = 10
      expect(result).toBe(10);
    });

    it('should throw error for steam score out of range', () => {
      expect(() => {
        PopularityCalculator.calculateMixedPopularity(101, 50);
      }).toThrow('Steam score must be between 0 and 100');

      expect(() => {
        PopularityCalculator.calculateMixedPopularity(-1, 50);
      }).toThrow('Steam score must be between 0 and 100');
    });

    it('should throw error for rawg score out of range', () => {
      expect(() => {
        PopularityCalculator.calculateMixedPopularity(50, 101);
      }).toThrow('RAWG score must be between 0 and 100');

      expect(() => {
        PopularityCalculator.calculateMixedPopularity(50, -1);
      }).toThrow('RAWG score must be between 0 and 100');
    });
  });
});
