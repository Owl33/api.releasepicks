import { Injectable, Logger } from '@nestjs/common';

import { UnifiedGameService } from '../unified-game.service';
import { CalendarUpdateGateway } from '../gateway/calendar-update.gateway';

@Injectable()
export class BatchSchedulerService {
  private readonly logger = new Logger(BatchSchedulerService.name);

  constructor(
    private readonly unifiedGameService: UnifiedGameService,
    private readonly calendarUpdateGateway: CalendarUpdateGateway,
  ) {}

  getTargetMonths(referenceDate: Date = new Date()): string[] {
    const year = referenceDate.getUTCFullYear();
    const monthIndex = referenceDate.getUTCMonth();

    const months = [
      this.formatMonth(this.shiftMonth(year, monthIndex, -1)),
      this.formatMonth({ year, month: monthIndex }),
      this.formatMonth(this.shiftMonth(year, monthIndex, 1)),
    ];

    return Array.from(new Set(months));
  }

  async run(referenceDate: Date = new Date()): Promise<void> {
    const months = this.getTargetMonths(referenceDate);
    const runId = referenceDate.toISOString();

    for (const month of months) {
      try {
        await this.unifiedGameService.saveUnifiedGamesToDatabase(month, {});
        await this.calendarUpdateGateway.publishMonthUpdate(month, runId);
        this.logger.log(`배치 실행 성공: ${month}`);
      } catch (error) {
        this.logger.error(
          `배치 실행 실패: ${month}`,
          (error as Error)?.stack || String(error),
        );
      }
    }
  }

  private shiftMonth(year: number, monthIndex: number, delta: number): {
    year: number;
    month: number;
  } {
    const date = new Date(Date.UTC(year, monthIndex + delta, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
  }

  private formatMonth(value: { year: number; month: number }): string {
    return `${value.year}-${String(value.month + 1).padStart(2, '0')}`;
  }
}
