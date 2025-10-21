// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';

// (선택) 공통 미들웨어/인터셉터/필터가 있다면 import
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseTransformInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { setupSwagger } from './swagger/swagger.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // 미들웨어
  app.use(new RequestIdMiddleware().use);

  // 글로벌 파이프(원하면)
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // 인터셉터
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new ResponseTransformInterceptor(),
  );

  // 필터
  app.useGlobalFilters(new HttpExceptionFilter(), new AllExceptionsFilter());

  // ⚠️ credentials=true면 origin='*' 금지 → 개발 기원만 명시
  app.enableCors({
    origin: ["http://localhost:3000","https://releasepicks.com"],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  });

  const port = Number(8080);

  // Swagger 문서 구성
  setupSwagger(app);

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`🚀 Server listening on http://localhost:${port}`);
}

bootstrap();
