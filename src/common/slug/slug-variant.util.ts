import { normalizeSlugCandidate } from './slug-normalizer.util';
import {
  convertRomanTokenToArabicString,
  convertRomanTokenToArabicNumber,
  arabicToRoman,
  isCanonicalRomanNumeral,
} from '../utils/roman.util';

const TOKEN_SPLIT_REGEX = /(\s+|[^\p{L}\p{N}]+)/u;
const DIGIT_TOKEN_REGEX = /^\d+$/;

/**
 * 원본 이름을 기준으로 로마 숫자/아라비아 숫자 변형 슬러그 후보를 생성한다.
 */
export function buildSlugVariantsFromName(name?: string | null): string[] {
  if (!name) return [];

  const baseSlug = normalizeSlugCandidate(name);
  const variants = new Set<string>();
  const parts = splitNameParts(name);

  const romanToNumber = parts
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      if (!isCanonicalRomanNumeral(trimmed)) return part;
      const converted = convertRomanTokenToArabicString(trimmed);
      return converted ?? part;
    })
    .join('');

  const numberToRoman = parts
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      if (!DIGIT_TOKEN_REGEX.test(trimmed)) return part;
      const numeric = Number(trimmed);
      if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 20) {
        return part;
      }
      try {
        return arabicToRoman(numeric);
      } catch {
        return part;
      }
    })
    .join('');

  const romanSlug = normalizeSlugCandidate(romanToNumber);
  if (romanSlug && romanSlug !== baseSlug) {
    variants.add(romanSlug);
  }

  const numberSlug = normalizeSlugCandidate(numberToRoman);
  if (numberSlug && numberSlug !== baseSlug) {
    variants.add(numberSlug);
  }

  return [...variants];
}

/**
 * 슬러그가 중복으로 생성되어 `-2` 등의 접미사가 붙은 경우 원본 기본 슬러그를 반환한다.
 */
export function detectDuplicateSlugBase(
  slug?: string | null,
  name?: string | null,
): string | null {
  if (!slug || !name) return null;
  const match = slug.match(/^(.+?)-(\d{1,3})$/);
  if (!match) return null;

  const base = match[1];
  const normalizedName = normalizeSlugCandidate(name);
  if (!normalizedName) return null;

  return normalizedName === base ? base : null;
}

/**
 * 이름에 등장하는 속편 번호(아라비아, 로마 숫자)를 추출한다.
 */
export function extractSequelNumbers(name?: string | null): number[] {
  if (!name) return [];
  const tokens = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
  const numbers: number[] = [];

  tokens.forEach((token) => {
    if (DIGIT_TOKEN_REGEX.test(token)) {
      numbers.push(Number(token));
      return;
    }
    const romanValue = convertRomanTokenToArabicNumber(token);
    if (romanValue !== null) {
      numbers.push(romanValue);
    }
  });

  return numbers;
}

function splitNameParts(value: string): string[] {
  if (!value) return [];
  const parts = value.split(TOKEN_SPLIT_REGEX);
  return parts.filter((part) => part.length > 0);
}
