import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { maskSensitive } from '../utils/mask.util';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const t0 = Date.now();
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<any>();
    const res = ctx.getResponse<any>();

    const method = req?.method;
    const url = req?.originalUrl || req?.url;
    const requestId = req?.requestId;
    const pfx = `[#${requestId ?? '-'}] ${method} ${url}`;

    // try {
    //   const params = maskSensitive(req?.params);
    //   const query = maskSensitive(req?.query);
    //   const body = maskSensitive(req?.body);
    //   this.logger.log(`${pfx} ▶️ 요청 | params=${JSON.stringify(params)} | query=${JSON.stringify(query)} | body=${JSON.stringify(body)}`);
    // } catch {
    //   this.logger.log(`${pfx} ▶️ 요청`);
    // }

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - t0;
          this.logger.log(
            `${pfx} ✅ 응답 | status=${res?.statusCode ?? '-'} | ${ms}ms`,
          );
        },
        error: (err) => {
          const ms = Date.now() - t0;
          this.logger.error(
            `${pfx} ❌ 에러 | status=${res?.statusCode ?? '-'} | ${ms}ms | ${err?.message}`,
          );
        },
      }),
    );
  }
}
