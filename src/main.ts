import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ? Number(process.env.PORT) : 8080;

  app.enableCors({
    origin: ['http://localhost:3000'],
    preflightContinue: false,
    credentials: true,
  });

  await app.listen(port);
  console.log(`🚀 서버가 포트 ${port}에서 실행 중입니다`);
}
bootstrap();
