import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { entities } from '../entities';

/**
 * 데이터베이스 연결 모듈
 * FINAL-ARCHITECTURE-DESIGN 9테이블 구조 기반
 *
 * 특징:
 * - PostgreSQL (Supabase) 연결
 * - TypeORM 설정
 * - 환경변수 기반 설정
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        database: configService.get<string>('DB_DATABASE'),
        username: configService.get<string>('DB_USER'),
        password: configService.get<string>('DB_PASSWORD'),
        entities: entities,
        synchronize: false,
        logging: configService.get<string>('NODE_ENV') === 'development',
        ssl: {
          rejectUnauthorized: false,
        },
        poolSize: 10,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        // 한국어 검색 지원
        extra: {
          charset: 'utf8mb4_unicode_ci',
        },
      }),
      inject: [ConfigService],
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
