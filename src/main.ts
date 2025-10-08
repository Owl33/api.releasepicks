// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseTransformInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

export async function buildServer() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(new RequestIdMiddleware().use);
  app.useGlobalInterceptors(new LoggingInterceptor(), new ResponseTransformInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter(), new AllExceptionsFilter());
  app.enableCors({
    origin: ['http://localhost:3000'], // 필요 시 도메인 추가
    credentials: true,
  });

  // ❗ Serverless에서는 listen 금지
  await app.init();

  // Express request listener 반환
  return app.getHttpAdapter().getInstance();
}
