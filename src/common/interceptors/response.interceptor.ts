import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<any>();
    const res = ctx.getResponse<any>();

    const requestId = req?.requestId;
    const path = req?.originalUrl || req?.url;
    const t0 = Date.now();

    return next.handle().pipe(
      map((data) => {
        // 컨트롤러가 파일/스트림을 직접 내려보내는 경우는 제외
        const statusCode = res?.statusCode ?? 200;
        return {
          statusCode,
          timestamp: new Date().toISOString(),
          path,
          requestId,
          message: 'OK',
          code: 'OK',
          data,
          error: null,
          meta: { elapsedMs: Date.now() - t0 },
        };
      }),
    );
  }
}
