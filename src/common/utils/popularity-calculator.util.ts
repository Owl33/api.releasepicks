/**
 * 인기도 계산 유틸리티
 *
 * Steam followers와 RAWG added 수치를 0-100 범위의 정규화된 점수로 변환하고,
 * 두 점수를 가중치를 적용하여 혼합합니다.
 */
export class PopularityCalculator {
  /**
   * Steam followers 수를 인기도 점수로 변환
   *
   * 공식: Math.min(100, Math.log10(followers + 1) * 20)
   * - 로그 스케일로 변환하여 큰 수의 영향력 완화
   * - 50,000 팔로워 ≈ 94점
   *
   * @param followers Steam 팔로워 수
   * @returns 0-100 범위의 정규화된 점수
   */
  static calculateSteamPopularity(followers: number): number {
    if (followers < 0) {
      throw new Error('Followers must be non-negative');
    }
    return Math.round(Math.min(100, Math.log10(followers + 1) * 20));
  }

  /**
   * RAWG added 수를 인기도 점수로 변환
   *
   * 공식: Math.min(100, Math.log10(added + 1) * 25)
   * - 로그 스케일로 변환하여 큰 수의 영향력 완화
   * - 5,000 added ≈ 93점
   *
   * @param added RAWG 컬렉션 추가 수
   * @returns 0-100 범위의 정규화된 점수
   */
  static calculateRawgPopularity(added: number): number {
    if (added < 0) {
      throw new Error('Added count must be non-negative');
    }
    return Math.round(Math.min(100, Math.log10(added + 1) * 25));
  }

  /**
   * Steam과 RAWG 점수를 가중치를 적용하여 혼합
   *
   * 공식: steamScore * 0.8 + rawgScore * 0.2
   * - Steam 가중치: 80% (더 신뢰도 높은 지표)
   * - RAWG 가중치: 20%
   *
   * @param steamScore Steam 인기도 점수 (0-100)
   * @param rawgScore RAWG 인기도 점수 (0-100)
   * @returns 혼합된 인기도 점수 (0-100)
   */
  static calculateMixedPopularity(
    steamScore: number,
    rawgScore: number,
  ): number {
    if (steamScore < 0 || steamScore > 100) {
      throw new Error('Steam score must be between 0 and 100');
    }
    if (rawgScore < 0 || rawgScore > 100) {
      throw new Error('RAWG score must be between 0 and 100');
    }
    return Math.round(steamScore * 0.8 + rawgScore * 0.2);
  }
}
