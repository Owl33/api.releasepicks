// api/index.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ValidationPipe } from '@nestjs/common';

// 선택: 공통 항목들 import
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware';
import { LoggingInterceptor } from '../src/common/interceptors/logging.interceptor';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

let cachedServer: any;

async function createServer() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // 동일한 세팅 (단, serverless는 listen() 금지)
  app.use(new RequestIdMiddleware().use);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new ResponseTransformInterceptor(),
  );
  app.useGlobalFilters(new HttpExceptionFilter(), new AllExceptionsFilter());

  // serverless 환경 CORS: credentials=false + 와일드카드 허용(필요시 기원 제한)
  app.enableCors({
    origin: '*',
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  });

  await app.init(); // ❗ listen() 호출 금지
  return app.getHttpAdapter().getInstance(); // Express requestListener
}

// Vercel 기본 핸들러 시그니처 (타입 불일치 피하려고 any 사용)
export default async function handler(req: any, res: any) {
  if (!cachedServer) {
    cachedServer = await createServer();
  }
  return cachedServer(req, res);
}
