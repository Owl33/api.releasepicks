import { Injectable, Logger } from '@nestjs/common';

export type CalendarUpdateType = 'game' | 'month';

export interface CalendarUpdateEvent {
  type: CalendarUpdateType;
  key: number | string;
  fields?: string[];
  runId?: string;
}

export abstract class CalendarUpdatePublisher {
  abstract publish(event: CalendarUpdateEvent): Promise<void>;
}

@Injectable()
export class NoopCalendarUpdatePublisher extends CalendarUpdatePublisher {
  private readonly logger = new Logger(NoopCalendarUpdatePublisher.name);

  async publish(event: CalendarUpdateEvent): Promise<void> {
    this.logger.debug(`Calendar update event dispatched`, event);
  }
}

@Injectable()
export class CalendarUpdateGateway {
  constructor(private readonly publisher: CalendarUpdatePublisher) {}

  async publishGameUpdate(
    key: number,
    fields: string[],
    runId?: string,
  ): Promise<void> {
    await this.publisher.publish({
      type: 'game',
      key,
      fields,
      runId,
    });
  }

  async publishMonthUpdate(key: string, runId?: string): Promise<void> {
    await this.publisher.publish({
      type: 'month',
      key,
      runId,
    });
  }
}
