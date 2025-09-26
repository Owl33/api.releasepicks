import { BatchSchedulerService } from '../../../src/unified-game/services/batch-scheduler.service';
import { UnifiedGameService } from '../../../src/unified-game/unified-game.service';
import { CalendarUpdateGateway } from '../../../src/unified-game/gateway/calendar-update.gateway';

describe('BatchSchedulerService', () => {
  let unifiedGameService: jest.Mocked<Partial<UnifiedGameService>>;
  let calendarGateway: jest.Mocked<Partial<CalendarUpdateGateway>>;
  let scheduler: BatchSchedulerService;

  beforeEach(() => {
    unifiedGameService = {
      saveUnifiedGamesToDatabase: jest.fn().mockResolvedValue({
        saved: 1,
        skipped: 0,
        errors: 0,
      }),
    };

    calendarGateway = {
      publishMonthUpdate: jest.fn().mockResolvedValue(undefined),
    };

    scheduler = new BatchSchedulerService(
      unifiedGameService as UnifiedGameService,
      calendarGateway as CalendarUpdateGateway,
    );
  });

  it('이전/현재/다음 달을 반환한다', () => {
    const months = scheduler.getTargetMonths(new Date(Date.UTC(2025, 0, 15)));
    expect(months).toEqual(['2024-12', '2025-01', '2025-02']);
  });

  it('연도 경계에서도 올바른 월을 계산한다', () => {
    const months = scheduler.getTargetMonths(new Date(Date.UTC(2025, 11, 1)));
    expect(months).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('배치 실행 시 월별 저장과 알림을 호출한다', async () => {
    const reference = new Date(Date.UTC(2025, 8, 1));
    await scheduler.run(reference);

    expect(unifiedGameService.saveUnifiedGamesToDatabase).toHaveBeenCalledTimes(3);
    expect(calendarGateway.publishMonthUpdate).toHaveBeenCalledTimes(3);

    expect(calendarGateway.publishMonthUpdate).toHaveBeenCalledWith(
      '2025-08',
      reference.toISOString(),
    );
  });

  it('저장 중 오류가 발생해도 다음 월을 계속 처리한다', async () => {
    (unifiedGameService.saveUnifiedGamesToDatabase as jest.Mock)
      .mockResolvedValueOnce({ saved: 1, skipped: 0, errors: 0 })
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ saved: 1, skipped: 0, errors: 0 });

    await scheduler.run(new Date(Date.UTC(2025, 5, 1)));

    expect(unifiedGameService.saveUnifiedGamesToDatabase).toHaveBeenCalledTimes(3);
    expect(calendarGateway.publishMonthUpdate).toHaveBeenCalledTimes(2);
  });
});
