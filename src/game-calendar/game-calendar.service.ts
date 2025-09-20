import { Injectable, Logger } from '@nestjs/common';

/**
 * GameCalendarService
 *
 * 추후 개인 DB와 소통하는 독립적인 서비스
 * 현재는 비어있는 상태 (Phase 2에서 DB 연동 예정)
 *
 * 역할:
 * - 내부 DB에서 게임 캘린더 데이터 조회
 * - 캐시된 게임 정보 제공
 * - DB 기반 필터링 및 정렬
 */
@Injectable()
export class GameCalendarService {
  private readonly logger = new Logger(GameCalendarService.name);

  constructor() {
    // 독립적인 서비스 - 다른 서비스 의존성 없음
    // 추후 DB Repository만 의존하게 될 예정
  }


}