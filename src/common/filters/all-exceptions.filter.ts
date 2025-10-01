import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<any>();
    const res = ctx.getResponse<any>();

    const status = exception?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const body = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: req?.originalUrl || req?.url,
      requestId: req?.requestId,
      message: process.env.NODE_ENV === 'production'
        ? '서버 내부 오류가 발생했습니다.'
        : (exception?.message || 'Unknown error'),
      code: 'INTERNAL_ERROR',
      data: null,
      error: process.env.NODE_ENV === 'production' ? null : { details: { name: exception?.name, stack: exception?.stack } },
      meta: { elapsedMs: 0 },
    };

    res.status(status).json(body);
  }
}
