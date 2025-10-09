/**
 * 인기도 계산 유틸리티 (구간 경계 고정 + 구간 내부 로그 보간)
 *
 * Steam followers 기준 10단계 등급을 절대 기준으로 사용:
 * S+ (90-100): 500,000+
 * S  (80-89):  200,000 - 499,999
 * A+ (70-79):  100,000 - 199,999
 * A  (60-69):  30,000  - 79,999
 * B+ (50-59):  10,000  - 19,999
 * B  (40-49):  5,000   - 9,999
 * C+ (30-39):  2,000   - 4,999
 * C  (20-29):  1,000   - 1,999
 * D  (10-19):  100     - 999
 * F  (0-9):    0       - 99
 *
 * - 각 등급 구간 경계는 고정.
 * - 각 구간 내부는 log10 보간으로 점수 분포를 자연스럽게.
 * - S+ 상단(500k 초과)은 log10로 500k~5,000k 구간을 90~100으로 매핑(상한 100).
 * - RAWG는 followers 등가치 = floor(added / 150)로 환산 후 동일 맵핑 적용.
 */
export class PopularityCalculator {
  // 등급 구간 정의(하한 followers, 점수 하한, 점수 상한, 상한 다음 구간의 하한)
  private static readonly BANDS = [
    { min: 0, scoreMin: 0, scoreMax: 9, nextMin: 100 }, // F
    { min: 100, scoreMin: 10, scoreMax: 19, nextMin: 1000 }, // D
    { min: 1000, scoreMin: 20, scoreMax: 29, nextMin: 2000 }, // C
    { min: 2000, scoreMin: 30, scoreMax: 39, nextMin: 5000 }, // C+
    { min: 5000, scoreMin: 40, scoreMax: 49, nextMin: 10000 }, // B
    { min: 10000, scoreMin: 50, scoreMax: 59, nextMin: 20000 }, // B+
    { min: 30000, scoreMin: 60, scoreMax: 69, nextMin: 80000 }, // A
    { min: 100000, scoreMin: 70, scoreMax: 79, nextMin: 200000 }, // A+
    { min: 200000, scoreMin: 80, scoreMax: 89, nextMin: 500000 }, // S
    // S+: 500k 이상은 별도 처리(아래 computeSPlus)
  ] as const;
  private static readonly RAWG_ADDED_TO_FOLLOWERS_FACTOR = Number(
    process.env.RAWG_ADDED_TO_FOLLOWERS_FACTOR ?? '150',
  );

  private static clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
  }

  /** 주어진 followers를 0~100 점수로 변환: 구간 경계 고정 + 구간 내부 log 보간 */
  private static computeScoreFromFollowers(followers: number): number {
    if (!Number.isFinite(followers) || followers < 0) {
      throw new Error('Followers must be a non-negative finite number');
    }

    if (followers >= 500_000) {
      // S+ 구간: 500k ~ 5,000k를 90~100으로 log 매핑, 상한 100
      return this.computeSPlus(followers);
    }

    // 해당 밴드 탐색
    for (let i = this.BANDS.length - 1; i >= 0; i--) {
      const band = this.BANDS[i];
      if (followers >= band.min) {
        const upper = band.nextMin;
        const loF = Math.max(band.min, 1); // log(0) 회피
        const hiF = Math.max(upper - 1, loF + 1);

        // 구간 내부 log10 보간 (followers in [loF, hiF])
        const t =
          (Math.log10(followers + 1) - Math.log10(loF + 1)) /
          (Math.log10(hiF + 1) - Math.log10(loF + 1));

        const raw = band.scoreMin + t * (band.scoreMax - band.scoreMin);
        return Math.round(this.clamp(raw, band.scoreMin, band.scoreMax));
      }
    }

    // followers == 0 인 경우 여기로 올 수 있음 → F 구간 최저점
    return 0;
  }

  /** S+ (500k+) 처리: 500k→90, 5,000k→100, 그 이상은 100으로 클램프 */
  private static computeSPlus(followers: number): number {
    const base = 500_000;
    const top = 5_000_000; // 상단 기준점
    // [base, top]을 log10로 90~100에 매핑
    const lo = Math.log10(base);
    const hi = Math.log10(top);
    const x = Math.log10(Math.max(followers, base));
    const t = (x - lo) / (hi - lo); // 0..1
    const score = 90 + t * 10;
    return Math.round(this.clamp(score, 90, 100));
  }

  /**
   * Steam followers → 인기도 점수(0-100)
   * - 등급 경계 고정, 내부 log 보간
   */
  static calculateSteamPopularity(followers: number): number {
    return this.computeScoreFromFollowers(followers);
  }

  /**
   * RAWG added → (added / 150) 팔로워 등가치 → 동일 맵핑
   * - "rawg의 인기도 계산은 스팀의 기준에 나누기 150정도" 규칙 반영
   */
  static calculateRawgPopularity(added: number): number {
    if (!Number.isFinite(added) || added < 0) {
      throw new Error('Added count must be a non-negative finite number');
    }
    // ✅ 올바른 환산: followers ≈ added × 150
    //    예) B 시작점 5,000 followers ↔ added ≈ 33.3
    const followersEquivalent = Math.round(
      added * this.RAWG_ADDED_TO_FOLLOWERS_FACTOR,
    );
    return this.computeScoreFromFollowers(followersEquivalent);
  }

  /**
   * 혼합 점수 (기본 80:20)
   * - 입력은 0~100을 기대
   */
  static calculateMixedPopularity(
    steamScore: number,
    rawgScore: number,
  ): number {
    if (
      !Number.isFinite(steamScore) ||
      !Number.isFinite(rawgScore) ||
      steamScore < 0 ||
      steamScore > 100 ||
      rawgScore < 0 ||
      rawgScore > 100
    ) {
      throw new Error('Scores must be between 0 and 100');
    }
    return Math.round(steamScore * 0.8 + rawgScore * 0.2);
  }

  /** (옵션) 점수 → 등급 문자열 */
  static gradeFromScore(
    score: number,
  ): 'S+' | 'S' | 'A+' | 'A' | 'B+' | 'B' | 'C+' | 'C' | 'D' | 'F' {
    if (score >= 90) return 'S+';
    if (score >= 80) return 'S';
    if (score >= 70) return 'A+';
    if (score >= 60) return 'A';
    if (score >= 50) return 'B+';
    if (score >= 40) return 'B';
    if (score >= 30) return 'C+';
    if (score >= 20) return 'C';
    if (score >= 10) return 'D';
    return 'F';
  }
}
