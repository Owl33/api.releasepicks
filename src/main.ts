// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { IncomingMessage, ServerResponse } from 'http';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseTransformInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

export async function buildServer() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(new RequestIdMiddleware().use);
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new ResponseTransformInterceptor(),
  );
  app.useGlobalFilters(new HttpExceptionFilter(), new AllExceptionsFilter());
  app.enableCors({
    origin: ['http://localhost:3000', 'https://game-calendar-two.vercel.app'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  });

  // ❗ serverless에서는 listen() 금지
  await app.init();
  return app.getHttpAdapter().getInstance(); // Express requestListener
}

// --- 여기가 핵심: default export로 핸들러 제공 ---
let cached: any;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (!cached) cached = await buildServer();
  return cached(req, res);
}
