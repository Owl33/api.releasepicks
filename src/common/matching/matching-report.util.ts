import { promises as fs } from 'fs';
import { join } from 'path';

export type MatchingLogKind = 'pending' | 'rejected' | 'errors';

export interface MatchingLogEntry {
  rawgId: number;
  rawgName: string;
  steamCandidateId?: number | null;
  steamName?: string | null;
  score: number;
  reason: string;
  overlap?: {
    companies?: string[];
    genres?: string[];
  };
  diff?: {
    releaseDays?: number | null;
  };
  slugCollision?: boolean;
  timestamp?: string;
  meta?: Record<string, unknown>;
}

export interface MatchingSummarySnapshot {
  processed: number;
  matched: number;
  pending: number;
  failed: number;
  averageScore: number;
  maxScore: number;
  minScore: number;
  reasons: Record<string, number>;
  startedAt: string;
  finishedAt?: string;
}

export interface MatchingReportWriterOptions {
  baseDir?: string;
}

/**
 * JSONL 기반 매칭 리포트를 작성하는 도우미
 */
export class MatchingReportWriter {
  private readonly baseDir: string;
  private summary: MatchingSummarySnapshot;

  constructor(options: MatchingReportWriterOptions = {}) {
    this.baseDir = options.baseDir ?? join(process.cwd(), 'logs', 'matching');
    const now = new Date().toISOString();
    this.summary = {
      processed: 0,
      matched: 0,
      pending: 0,
      failed: 0,
      averageScore: 0,
      maxScore: 0,
      minScore: 1,
      reasons: {},
      startedAt: now,
    };
  }

  /**
   * 로그 파일에 JSONL 레코드를 추가한다.
   */
  async append(kind: MatchingLogKind, entry: MatchingLogEntry) {
    await this.ensureDir();
    const file = this.resolvePath(kind);
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    });
    await fs.appendFile(file, `${line}\n`, 'utf8');
  }

  /**
   * 집계 정보에 결과를 반영한다.
   */
  recordResult(
    result: 'matched' | 'pending' | 'failed',
    score: number,
    reason?: string,
  ) {
    this.summary.processed += 1;
    if (result === 'matched') this.summary.matched += 1;
    else if (result === 'pending') this.summary.pending += 1;
    else this.summary.failed += 1;

    const totalScore =
      this.summary.averageScore * (this.summary.processed - 1) + score;
    this.summary.averageScore = Number(
      (totalScore / this.summary.processed).toFixed(4),
    );

    this.summary.maxScore = Math.max(this.summary.maxScore, score);
    this.summary.minScore = Math.min(this.summary.minScore, score);

    if (reason) {
      this.summary.reasons[reason] = (this.summary.reasons[reason] ?? 0) + 1;
    }
  }

  /**
   * 요약 JSON을 기록한다.
   */
  async flushSummary() {
    await this.ensureDir();
    this.summary.finishedAt = new Date().toISOString();
    const file = this.getSummaryPath();
    await fs.writeFile(file, JSON.stringify(this.summary, null, 2), 'utf8');
  }

  getLogPath(kind: MatchingLogKind) {
    return this.resolvePath(kind);
  }

  getSummaryPath() {
    return join(this.baseDir, 'migrate_rawg_only.summary.json');
  }

  private resolvePath(kind: MatchingLogKind) {
    return join(this.baseDir, `migrate_rawg_only.${kind}.jsonl`);
  }

  private async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }
}
