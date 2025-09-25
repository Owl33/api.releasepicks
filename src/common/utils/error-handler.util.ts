/**
 * 🛡️ 통합 에러 처리 유틸리티
 * try-catch 패턴을 표준화하고 중복을 제거
 */

import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ErrorCodes } from '../filters/global-exception.filter';

export interface ErrorHandlerOptions {
  context?: string;
  identifier?: string;
  rethrow?: boolean;
  defaultMessage?: string;
  httpStatus?: HttpStatus;
  errorCode?: string;
}

export class ErrorHandlerUtil {
  /**
   * 🔄 비동기 함수 실행을 안전하게 래핑
   * try-catch 패턴을 자동으로 적용하고 에러를 표준화
   */
  static async executeWithErrorHandling<T>(
    operation: () => Promise<T>,
    logger: Logger,
    options: ErrorHandlerOptions = {}
  ): Promise<T> {
    const {
      context = 'Unknown Operation',
      identifier,
      rethrow = true,
      defaultMessage,
      httpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode
    } = options;

    try {
      // 🔄 통합 시스템: 로깅은 GlobalExceptionFilter와 ResponseInterceptor에서 처리
      const result = await operation();
      return result;
    } catch (error) {
      const processedError = this.processError(error, {
        context,
        identifier,
        defaultMessage,
        httpStatus,
        errorCode
      });

      // 🔄 로깅은 GlobalExceptionFilter에서 처리하므로 여기서는 제거
      // LoggerHelper.logError(logger, context, processedError, identifier);

      if (rethrow) {
        throw processedError;
      }

      return null as T;
    }
  }

  /**
   * 🎯 API 호출을 안전하게 래핑 (axios, fetch 등)
   * API 관련 에러 처리에 특화
   */
  static async executeApiCall<T>(
    apiCall: () => Promise<T>,
    logger: Logger,
    apiName: string,
    identifier?: string
  ): Promise<T> {
    return this.executeWithErrorHandling(
      apiCall,
      logger,
      {
        context: `${apiName} API 호출`,
        identifier,
        errorCode: ErrorCodes.API_CALL_FAILED,
        httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
        defaultMessage: `${apiName} API 호출 실패`
      }
    );
  }

  /**
   * 🗄️ 데이터베이스 작업을 안전하게 래핑
   * DB 관련 에러 처리에 특화
   */
  static async executeDatabaseOperation<T>(
    dbOperation: () => Promise<T>,
    logger: Logger,
    operation: string,
    identifier?: string
  ): Promise<T> {
    return this.executeWithErrorHandling(
      dbOperation,
      logger,
      {
        context: `DB ${operation}`,
        identifier,
        errorCode: ErrorCodes.DATABASE_ERROR,
        httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
        defaultMessage: `데이터베이스 ${operation} 실패`
      }
    );
  }

  /**
   * 🎮 Steam API 호출을 안전하게 래핑
   */
  static async executeSteamApiCall<T>(
    steamCall: () => Promise<T>,
    logger: Logger,
    operation: string,
    steamId?: string | number
  ): Promise<T> {
    return this.executeWithErrorHandling(
      steamCall,
      logger,
      {
        context: `Steam ${operation}`,
        identifier: steamId?.toString(),
        errorCode: ErrorCodes.STEAM_API_ERROR,
        httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
        defaultMessage: `Steam ${operation} 실패`
      }
    );
  }

  /**
   * 🎬 RAWG API 호출을 안전하게 래핑
   */
  static async executeRawgApiCall<T>(
    rawgCall: () => Promise<T>,
    logger: Logger,
    operation: string,
    gameId?: string | number
  ): Promise<T> {
    return this.executeWithErrorHandling(
      rawgCall,
      logger,
      {
        context: `RAWG ${operation}`,
        identifier: gameId?.toString(),
        errorCode: ErrorCodes.RAWG_API_ERROR,
        httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
        defaultMessage: `RAWG ${operation} 실패`
      }
    );
  }

  /**
   * 📺 YouTube API 호출을 안전하게 래핑
   */
  static async executeYoutubeApiCall<T>(
    youtubeCall: () => Promise<T>,
    logger: Logger,
    operation: string,
    gameName?: string
  ): Promise<T> {
    return this.executeWithErrorHandling(
      youtubeCall,
      logger,
      {
        context: `YouTube ${operation}`,
        identifier: gameName,
        errorCode: ErrorCodes.YOUTUBE_API_ERROR,
        httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
        defaultMessage: `YouTube ${operation} 실패`
      }
    );
  }

  /**
   * ⚡ 재시도 로직이 포함된 안전한 실행
   */
  static async executeWithRetry<T>(
    operation: () => Promise<T>,
    logger: Logger,
    options: ErrorHandlerOptions & {
      maxRetries?: number;
      retryDelay?: number;
      retryCondition?: (error: any) => boolean;
    } = {}
  ): Promise<T> {
    const {
      maxRetries = 3,
      retryDelay = 1000,
      retryCondition = () => true,
      ...errorOptions
    } = options;

    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.executeWithErrorHandling(
          operation,
          logger,
          {
            ...errorOptions,
            context: `${errorOptions.context || 'Retry Operation'} (시도 ${attempt}/${maxRetries})`,
            rethrow: false
          }
        );
      } catch (error) {
        lastError = error;

        if (attempt === maxRetries || !retryCondition(error)) {
          break;
        }

        // 🔄 통합 시스템: 재시도 로깅도 GlobalExceptionFilter에서 처리
        // LoggerHelper.logWarn 제거 - 중복 로깅 방지

        await this.delay(retryDelay);
      }
    }

    throw this.processError(lastError, {
      ...errorOptions,
      defaultMessage: `${maxRetries}회 재시도 후 실패: ${errorOptions.defaultMessage || '작업 실패'}`
    });
  }

  /**
   * 🔍 에러 객체를 표준 형태로 처리
   */
  private static processError(
    error: any,
    options: Omit<ErrorHandlerOptions, 'rethrow'> = {}
  ): Error | HttpException {
    const { context, identifier, defaultMessage, httpStatus, errorCode } = options;

    let message: string;
    let finalErrorCode: string;

    // 기존 HttpException인 경우 그대로 유지
    if (error instanceof HttpException) {
      return error;
    }

    // Error 메시지 처리
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error?.message) {
      message = error.message;
    } else {
      message = defaultMessage || `${context} 실패`;
    }

    // 에러 코드 결정
    finalErrorCode = errorCode || this.inferErrorCodeFromMessage(message);

    // 식별자가 있는 경우 메시지에 포함
    if (identifier) {
      message = `${message} (${identifier})`;
    }

    // HTTP 상태 코드가 지정된 경우 HttpException 생성
    if (httpStatus && httpStatus !== HttpStatus.INTERNAL_SERVER_ERROR) {
      throw new HttpException(
        {
          code: finalErrorCode,
          message,
          details: error?.details || error?.stack
        },
        httpStatus
      );
    }

    // 일반 Error 객체 생성
    const processedError = new Error(message);
    (processedError as any).code = finalErrorCode;
    return processedError;
  }

  /**
   * 🎯 메시지에서 에러 코드 추론
   */
  private static inferErrorCodeFromMessage(message: string): string {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes('steam')) return ErrorCodes.STEAM_API_ERROR;
    if (lowerMessage.includes('rawg')) return ErrorCodes.RAWG_API_ERROR;
    if (lowerMessage.includes('youtube')) return ErrorCodes.YOUTUBE_API_ERROR;
    if (lowerMessage.includes('api')) return ErrorCodes.API_CALL_FAILED;
    if (lowerMessage.includes('database') || lowerMessage.includes('db')) {
      return ErrorCodes.DATABASE_ERROR;
    }
    if (lowerMessage.includes('timeout')) return ErrorCodes.TIMEOUT_ERROR;

    return ErrorCodes.INTERNAL_SERVER_ERROR;
  }

  /**
   * ⏱️ 딜레이 유틸리티
   */
  private static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}