-- slug-uniqueness-audit.sql
-- 목적: slug/og_slug 패턴과 접미사 사용 현황을 점검
-- 사용법: psql -f scripts/reports/slug-uniqueness-audit.sql

WITH normalized AS (
  SELECT
    id,
    slug,
    og_slug,
    lower(slug) AS slug_lower,
    lower(og_slug) AS og_lower
  FROM public.games
  WHERE slug IS NOT NULL OR og_slug IS NOT NULL
)
SELECT
  REGEXP_REPLACE(slug_lower, '-\\d+$', '') AS base_slug,
  COUNT(*) AS total_variants,
  MAX(CASE WHEN slug_lower ~ '-\\d+$' THEN 1 ELSE 0 END) AS has_suffix
FROM normalized
GROUP BY 1
HAVING COUNT(*) > 1 OR MAX(CASE WHEN slug_lower ~ '-\\d+$' THEN 1 ELSE 0 END) = 1
ORDER BY total_variants DESC, base_slug
LIMIT 200;
