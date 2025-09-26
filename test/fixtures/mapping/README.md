# 매핑 결과 픽스처 구조 안내

이 디렉터리는 Stage 6 Persistence 리팩터링 대비용으로 `GameMappingService` 출력(= `GameCalendarData`) 예시를 보관한다. 목적은 다음과 같다.

- 매핑 단계에서 어떤 필드가 채워지는지 한눈에 확인
- Persistence 계층 단위 테스트에서 동일 데이터를 재사용해 `shouldUpdateGame` 로직 검증
- Stage 8 테스트 작성 시 표준화된 입력 샘플 제공

## 파일 목록

- `rawg-to-calendar.sample.json`
  - RAWG 수집 데이터만 있을 때 `createFromRawg` 호출 결과 예시
- `steam-merged.sample.json`
  - Steam 병합 후 `mergeWithSteam` 결과 예시 (분류 적용 전 상태)

각 파일은 `GameCalendarData`를 그대로 직렬화한 구조를 따른다. 필드 값은 더미이며, 실제 테스트에서는 필요한 항목만 선택적으로 사용한다.

추후 Persistence 테스트를 작성할 때에는 이 파일을 기반으로 엔티티 매핑 기대값을 생성하고, 변경 여부 판단 로직이 동일한 참조 데이터를 사용하도록 유지한다.
