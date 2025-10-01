/**
 * 엔티티 인덱스 파일
 * FINAL-ARCHITECTURE-DESIGN 9테이블 구조 엔티티 모음
 */

// ===== 핵심 데이터 테이블 (3개) =====
export { Game } from './game.entity';
export { GameDetail } from './game-detail.entity';
export { GameRelease } from './game-release.entity';

// ===== 회사 정보 테이블 (2개) =====
export { Company } from './company.entity';
export { GameCompanyRole } from './game-company-role.entity';

// ===== ETL/로깅 테이블 (4개) - 개선된 네이밍 =====
export { DataSyncStatus } from './data-sync-status.entity';
export { PipelineRun } from './pipeline-run.entity';
export { PipelineItem } from './pipeline-item.entity';
export { SystemEvent } from './system-event.entity';

// ===== Enum 타입 =====
export {
  GameType,
  ReleaseStatus,
  Platform,
  Store,
  CompanyRole,
  EnumDefinitions
} from './enums';

// ===== 엔티티 배열 (TypeORM 설정용) =====
import { Game } from './game.entity';
import { GameDetail } from './game-detail.entity';
import { GameRelease } from './game-release.entity';
import { Company } from './company.entity';
import { GameCompanyRole } from './game-company-role.entity';
import { DataSyncStatus } from './data-sync-status.entity';
import { PipelineRun } from './pipeline-run.entity';
import { PipelineItem } from './pipeline-item.entity';
import { SystemEvent } from './system-event.entity';

export const entities = [
  // 핵심 데이터 테이블
  Game,
  GameDetail,
  GameRelease,

  // 회사 정보 테이블
  Company,
  GameCompanyRole,

  // ETL/로깅 테이블 (개선된 네이밍)
  DataSyncStatus,
  PipelineRun,
  PipelineItem,
  SystemEvent
];