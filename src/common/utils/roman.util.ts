/**
 * 로마 숫자 ↔ 아라비아 숫자 변환 유틸리티
 * - canonical 판별을 통해 잘못된 값(예: IIV)을 필터링한다.
 */

const ROMAN_VALUES: Record<string, number> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
};

const ROMAN_TOKEN_REGEX = /^[IVXLCDM]+$/;

export function arabicToRoman(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value >= 4000) {
    throw new RangeError(`로마 숫자로 변환할 수 없는 값: ${value}`);
  }

  const numerals: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];

  let remaining = value;
  let result = '';

  for (const [arabic, roman] of numerals) {
    while (remaining >= arabic) {
      result += roman;
      remaining -= arabic;
    }
  }

  return result;
}

export function romanToArabic(roman: string): number | null {
  if (!roman || !ROMAN_TOKEN_REGEX.test(roman)) return null;

  let total = 0;
  let prev = 0;

  for (let i = roman.length - 1; i >= 0; i -= 1) {
    const symbol = roman[i];
    const value = ROMAN_VALUES[symbol];
    if (!value) return null;
    if (value < prev) {
      total -= value;
    } else {
      total += value;
      prev = value;
    }
  }

  return total;
}

export function isCanonicalRomanNumeral(token: string): boolean {
  const trimmed = token?.trim();
  if (!trimmed) return false;
  const upper = trimmed.toUpperCase();
  if (!ROMAN_TOKEN_REGEX.test(upper)) return false;
  const arabic = romanToArabic(upper);
  if (arabic === null || arabic <= 0 || arabic >= 4000) return false;
  return arabicToRoman(arabic) === upper;
}

export function convertRomanTokenToArabicString(token: string): string | null {
  if (!token) return null;
  const upper = token.toUpperCase();
  if (!ROMAN_TOKEN_REGEX.test(upper)) return null;
  const arabic = romanToArabic(upper);
  if (arabic === null || arabic <= 0 || arabic >= 4000) return null;
  if (arabicToRoman(arabic) !== upper) return null;
  return String(arabic);
}

export function convertRomanTokenToArabicNumber(token: string): number | null {
  const converted = convertRomanTokenToArabicString(token);
  if (!converted) return null;
  const numeric = Number(converted);
  return Number.isFinite(numeric) ? numeric : null;
}
