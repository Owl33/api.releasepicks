/**
 * 🛡️ 통합 글로벌 Exception Filter
 * 모든 예외를 일관된 형태로 처리하고 응답
 */

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiResponse } from '../interfaces/api-response.interface';

export enum ErrorCodes {
  // API 관련 에러
  API_CALL_FAILED = 'API_CALL_FAILED',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',

  // 데이터 관련 에러
  DATA_NOT_FOUND = 'DATA_NOT_FOUND',
  INVALID_DATA_FORMAT = 'INVALID_DATA_FORMAT',
  DATABASE_ERROR = 'DATABASE_ERROR',

  // Steam 관련 에러
  STEAM_ID_NOT_FOUND = 'STEAM_ID_NOT_FOUND',
  STEAM_API_ERROR = 'STEAM_API_ERROR',

  // RAWG 관련 에러
  RAWG_API_ERROR = 'RAWG_API_ERROR',

  // YouTube 관련 에러
  YOUTUBE_API_ERROR = 'YOUTUBE_API_ERROR',
  TRAILER_NOT_FOUND = 'TRAILER_NOT_FOUND',

  // 일반 에러
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const timestamp = new Date().toISOString();
    const path = request.url;

    let status: HttpStatus;
    let errorCode: string;
    let message: string;
    let details: any = null;

    if (exception instanceof HttpException) {
      // HTTP Exception 처리
      status = exception.getStatus();
      const errorResponse = exception.getResponse();

      if (typeof errorResponse === 'string') {
        message = errorResponse;
        errorCode = this.getErrorCodeFromStatus(status);
      } else if (typeof errorResponse === 'object') {
        message = (errorResponse as any).message || exception.message;
        errorCode =
          (errorResponse as any).code || this.getErrorCodeFromStatus(status);
        details = (errorResponse as any).details;
      } else {
        message = exception.message;
        errorCode = this.getErrorCodeFromStatus(status);
      }
    } else if (exception instanceof Error) {
      // 일반 Error 처리
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = exception.message;
      errorCode = this.getErrorCodeFromMessage(message);

      // Stack trace는 개발 환경에서만 포함
      if (process.env.NODE_ENV === 'development') {
        details = { stack: exception.stack };
      }
    } else {
      // 알 수 없는 예외 처리
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error occurred';
      errorCode = ErrorCodes.INTERNAL_SERVER_ERROR;
    }

    // 에러 로깅
    this.logger.error(
      `${errorCode}: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
      `${request.method} ${path}`,
    );

    // 표준 에러 응답 생성
    const errorResponse: ApiResponse = {
      success: false,
      error: {
        code: errorCode,
        message,
        details,
      },
      timestamp,
      path,
    };

    response.status(status).json(errorResponse);
  }

  /**
   * HTTP 상태 코드로부터 에러 코드 추출
   */
  private getErrorCodeFromStatus(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCodes.VALIDATION_ERROR;
      case HttpStatus.NOT_FOUND:
        return ErrorCodes.DATA_NOT_FOUND;
      case HttpStatus.REQUEST_TIMEOUT:
        return ErrorCodes.TIMEOUT_ERROR;
      default:
        return ErrorCodes.INTERNAL_SERVER_ERROR;
    }
  }

  /**
   * 에러 메시지로부터 에러 코드 추론
   */
  private getErrorCodeFromMessage(message: string): string {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes('steam')) {
      if (
        lowerMessage.includes('id') &&
        lowerMessage.includes('찾을 수 없습니다')
      ) {
        return ErrorCodes.STEAM_ID_NOT_FOUND;
      }
      return ErrorCodes.STEAM_API_ERROR;
    }

    if (lowerMessage.includes('rawg')) {
      return ErrorCodes.RAWG_API_ERROR;
    }

    if (lowerMessage.includes('youtube') || lowerMessage.includes('트레일러')) {
      if (lowerMessage.includes('찾을 수 없습니다')) {
        return ErrorCodes.TRAILER_NOT_FOUND;
      }
      return ErrorCodes.YOUTUBE_API_ERROR;
    }

    if (lowerMessage.includes('api')) {
      return ErrorCodes.API_CALL_FAILED;
    }

    if (lowerMessage.includes('database') || lowerMessage.includes('db')) {
      return ErrorCodes.DATABASE_ERROR;
    }

    if (lowerMessage.includes('timeout') || lowerMessage.includes('타임아웃')) {
      return ErrorCodes.TIMEOUT_ERROR;
    }

    return ErrorCodes.INTERNAL_SERVER_ERROR;
  }
}
