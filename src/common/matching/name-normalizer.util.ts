import { NormalizedNameResult } from './matching.types';
import { normalizeSlugCandidate } from '../slug/slug-normalizer.util';

const 불용어 = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'for',
  'edition',
  'definitive',
  'remastered',
  'hd',
]);

const 로마숫자정규식 = /\b[ivxlcdm]+\b/g;

const 토큰분리정규식 = /[^\p{L}\p{N}]+/u;

/**
 * 게임 이름을 매칭용으로 정규화한다.
 */
export function normalizeGameName(raw: string): NormalizedNameResult {
  const original = raw ?? '';
  const normalized = original.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const romanConverted = 치환로마숫자(normalized);
  const tokens = buildTokenSet(romanConverted);
  const looseSlug = buildLooseSlug(original);
  const compact = romanConverted.replace(/[^\p{L}\p{N}]+/gu, '');

  return { original, lowercase: romanConverted, tokens, looseSlug, compact };
}

/**
 * 이름을 토큰 배열로 변환한다.
 */
export function buildTokenSet(value: string): string[] {
  if (!value) return [];

  return value
    .split(토큰분리정규식)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 || /^\d+$/.test(t))
    .map((t) => convertRomanToken(t) ?? t)
    .filter((t) => !불용어.has(t));
}

/**
 * slugify와 동일한 규칙으로 루즈 슬러그를 생성한다.
 */
export function buildLooseSlug(value: string): string {
  return normalizeSlugCandidate(value);
}

function 치환로마숫자(value: string): string {
  return value.replace(로마숫자정규식, (match) => convertRomanToken(match) ?? match);
}

function convertRomanToken(token: string): string | null {
  const upper = token.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(upper)) return null;

  const value = romanToArabic(upper);
  if (value === null || value <= 0 || value > 3999) return null;

  const canonical = arabicToRoman(value);
  if (canonical !== upper) return null;

  return String(value);
}

function romanToArabic(roman: string): number | null {
  const values: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };

  let total = 0;
  let prev = 0;

  for (let i = roman.length - 1; i >= 0; i -= 1) {
    const current = values[roman[i]];
    if (!current) return null;
    if (current < prev) {
      total -= current;
    } else {
      total += current;
      prev = current;
    }
  }

  return total;
}

function arabicToRoman(value: number): string {
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
