import slugify from 'slugify';

/**
 * SlugPolicy와 동일한 규칙으로 문자열을 슬러그로 정규화한다.
 */
export function normalizeSlugCandidate(
  value: string | null | undefined,
): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  const base = slugify(trimmed, {
    lower: true,
    strict: false,
    locale: 'ko',
    remove: /[^a-zA-Z0-9가-힣\s-]/g,
    replacement: '-',
    trim: true,
  })
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return base ? base.slice(0, 120) : '';
}
