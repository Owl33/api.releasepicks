/**
 * 🎯 응답 표준화 Interceptor
 * 모든 성공 응답을 일관된 ApiResponse 형태로 변환
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { ApiResponse } from '../interfaces/api-response.interface';

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();

    return next.handle().pipe(
      map((data) => {
        const timestamp = new Date().toISOString();
        const path = request.url;

        // 이미 ApiResponse 형태인 경우 timestamp와 path만 추가
        if (this.isApiResponse(data)) {
          return {
            ...data,
            timestamp,
            path,
          };
        }

        // 기본 성공 응답 형태로 변환
        return {
          success: true,
          data,
          message: this.getSuccessMessage(request.method, path),
          timestamp,
          path,
        };
      }),
    );
  }

  /**
   * 데이터가 이미 ApiResponse 형태인지 확인
   */
  private isApiResponse(data: any): boolean {
    return (
      data && typeof data === 'object' && typeof data.success === 'boolean'
    );
  }

  /**
   * HTTP 메서드와 경로에 따른 기본 성공 메시지 생성
   */
  private getSuccessMessage(method: string, path: string): string {
    const cleanPath = path.split('?')[0]; // 쿼리 파라미터 제거

    if (method === 'GET') {
      if (cleanPath.includes('status')) return '처리 상태 조회 완료';
      if (cleanPath.includes('search')) return '검색 완료';
      if (cleanPath.includes('steam')) return 'Steam 데이터 조회 완료';
      if (cleanPath.includes('youtube')) return 'YouTube 데이터 조회 완료';
      if (cleanPath.includes('unified-games'))
        return '통합 게임 데이터 조회 완료';
      return '데이터 조회 완료';
    }

    if (method === 'POST') {
      if (cleanPath.includes('save')) return '데이터 저장 완료';
      if (cleanPath.includes('unified-games'))
        return '통합 게임 데이터 저장 완료';
      return '작업 완료';
    }

    if (method === 'PUT') {
      return '데이터 업데이트 완료';
    }

    if (method === 'DELETE') {
      if (cleanPath.includes('cache')) return '캐시 삭제 완료';
      return '데이터 삭제 완료';
    }

    return '작업 완료';
  }
}
