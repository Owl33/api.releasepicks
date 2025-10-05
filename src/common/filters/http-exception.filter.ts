import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<any>();
    const res = ctx.getResponse<any>();

    const status = exception.getStatus();
    const payload: any = exception.getResponse();
    const message =
      typeof payload === 'string'
        ? payload
        : payload?.message || payload?.error || exception.message;

    const body = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: req?.originalUrl || req?.url,
      requestId: req?.requestId,
      message,
      code: payload?.error || exception.name || 'HTTP_EXCEPTION',
      data: null,
      error:
        process.env.NODE_ENV === 'production' ? null : { details: payload },
      meta: { elapsedMs: 0 },
    };

    res.status(status).json(body);
  }
}
