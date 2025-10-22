import { NormalizedNameResult } from './matching.types';
import { normalizeSlugCandidate } from '../slug/slug-normalizer.util';
import { convertRomanTokenToArabicString } from '../utils/roman.util';

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
  const normalized = original
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
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
  return value.replace(
    로마숫자정규식,
    (match) => convertRomanToken(match) ?? match,
  );
}

function convertRomanToken(token: string): string | null {
  return convertRomanTokenToArabicString(token);
}
