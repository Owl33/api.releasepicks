-- 실패한 rawg_id들의 데이터 확인
SELECT
  id,
  rawg_id,
  name,
  og_name,
  slug,
  og_slug,
  release_date_date,
  popularity_score
FROM games
WHERE rawg_id IN (321226, 42370, 52390, 42236)
  AND steam_id IS NULL
ORDER BY popularity_score DESC;

-- 해당 게임들과 유사한 이름을 가진 Steam 게임 확인
SELECT
  id,
  steam_id,
  name,
  og_name,
  slug,
  og_slug,
  release_date_date,
  popularity_score
FROM games
WHERE steam_id IS NOT NULL
  AND rawg_id IS NULL
  AND (
    name ILIKE '%' || (SELECT name FROM games WHERE rawg_id = 321226 LIMIT 1) || '%'
    OR og_name ILIKE '%' || (SELECT name FROM games WHERE rawg_id = 321226 LIMIT 1) || '%'
  )
LIMIT 5;
