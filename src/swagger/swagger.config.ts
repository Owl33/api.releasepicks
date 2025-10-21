import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Swagger 문서 구성
 * - dev/stage 환경에서 기본적으로 활성화
 * - 운영 환경에서도 보호가 필요하면 추후 Basic Auth 등 보강
 */
export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Game Calendar API')
    .setDescription('게임 출시 캘린더 백엔드 API 명세입니다.')
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: '인증이 필요한 엔드포인트에 JWT를 입력하세요.',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    deepScanRoutes: true,
  });

  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
    customSiteTitle: 'Game Calendar API Docs',
  });
}
