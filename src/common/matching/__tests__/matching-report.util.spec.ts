import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { MatchingReportWriter } from '../matching-report.util';

describe('matching-report util', () => {
  it('JSONL 로그와 요약 파일을 생성한다', async () => {
    const baseDir = join(tmpdir(), `matching-report-${Date.now()}`);
    const writer = new MatchingReportWriter({ baseDir });

    await writer.append('pending', {
      rawgId: 1,
      rawgName: 'Sample RAWG',
      score: 0.7,
      reason: 'SCORE_THRESHOLD_PENDING',
    });
    writer.recordResult('pending', 0.7, 'SCORE_THRESHOLD_PENDING');
    await writer.flushSummary();

    const log = await fs.readFile(
      join(baseDir, 'migrate_rawg_only.pending.jsonl'),
      'utf8',
    );
    const summary = JSON.parse(
      await fs.readFile(
        join(baseDir, 'migrate_rawg_only.summary.json'),
        'utf8',
      ),
    );

    expect(log.trim()).toContain('"rawgId":1');
    expect(summary.processed).toBe(1);
    expect(summary.pending).toBe(1);

    expect(writer.getLogPath('pending')).toBe(
      join(baseDir, 'migrate_rawg_only.pending.jsonl'),
    );
    expect(writer.getSummaryPath()).toBe(
      join(baseDir, 'migrate_rawg_only.summary.json'),
    );
  });
});
