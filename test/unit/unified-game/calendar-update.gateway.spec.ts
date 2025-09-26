import { CalendarUpdateGateway, CalendarUpdatePublisher } from '../../../src/unified-game/gateway/calendar-update.gateway';

describe('CalendarUpdateGateway', () => {
  it('publishGameUpdate가 publisher를 호출한다', async () => {
    const publisher: CalendarUpdatePublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;

    const gateway = new CalendarUpdateGateway(publisher);
    await gateway.publishGameUpdate(12345, ['price', 'release_status'], 'run-1');

    expect(publisher.publish).toHaveBeenCalledWith({
      type: 'game',
      key: 12345,
      fields: ['price', 'release_status'],
      runId: 'run-1',
    });
  });

  it('publishMonthUpdate가 publisher를 호출한다', async () => {
    const publisher: CalendarUpdatePublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;

    const gateway = new CalendarUpdateGateway(publisher);
    await gateway.publishMonthUpdate('2025-10', 'run-2');

    expect(publisher.publish).toHaveBeenCalledWith({
      type: 'month',
      key: '2025-10',
      runId: 'run-2',
    });
  });
});
