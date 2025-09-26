import { Logger } from '@nestjs/common';

export class LoggerHelper {
  static logStart(logger: Logger, operation: string, context?: unknown): void {
    const contextStr =
      context !== undefined
        ? ` (${typeof context === 'object' ? JSON.stringify(context) : context})`
        : '';
    logger.log(`${operation} 시작${contextStr}`);
  }

  static logComplete(logger: Logger, operation: string, stats?: unknown): void {
    let statsStr = '';
    if (stats !== undefined) {
      if (typeof stats === 'object' && stats !== null) {
        const entries = Object.entries(stats).map(
          ([key, value]) => `${key}: ${value}`,
        );
        statsStr = ` - ${entries.join(', ')}`;
      } else {
        statsStr = ` - ${stats}`;
      }
    }
    logger.log(`${operation} 완료${statsStr}`);
  }

  static logError(
    logger: Logger,
    operation: string,
    error: unknown,
    context?: unknown,
  ): void {
    const message = (error as { message?: string })?.message || String(error);
    const contextStr =
      context !== undefined
        ? ` (컨텍스트: ${
            typeof context === 'object' ? JSON.stringify(context) : context
          })`
        : '';
    logger.error(`${operation} 실패: ${message}${contextStr}`);
  }

  static logWarning(
    logger: Logger,
    operation: string,
    reason: string,
    context?: unknown,
  ): void {
    const contextStr =
      context !== undefined
        ? ` (${typeof context === 'object' ? JSON.stringify(context) : context})`
        : '';
    logger.warn(`${operation} 경고: ${reason}${contextStr}`);
  }

  static logStats(
    logger: Logger,
    operation: string,
    stats: Record<string, unknown>,
    processingTime?: number,
  ): void {
    const statsEntries = Object.entries(stats).map(
      ([key, value]) => `${key}: ${value}`,
    );
    const timeStr = processingTime ? ` - ${processingTime}ms` : '';
    logger.log(`${operation} 통계: ${statsEntries.join(', ')}${timeStr}`);
  }
}
