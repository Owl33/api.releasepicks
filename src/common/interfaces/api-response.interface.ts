/**
 * 🎯 표준 API 응답 인터페이스
 * 모든 API 엔드포인트에서 일관된 응답 구조 제공
 */

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  timestamp: string;
  path: string;
}

export interface PaginatedApiResponse<T = any> extends ApiResponse<T[]> {
  pagination?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

/**
 * 🔧 성공 응답 헬퍼
 */
export class ApiResponseHelper {
  static success<T>(
    data: T,
    message?: string,
  ): Omit<ApiResponse<T>, 'timestamp' | 'path'> {
    return {
      success: true,
      data,
      message: message || 'Operation completed successfully',
    };
  }

  static error(
    code: string,
    message: string,
    details?: any,
  ): Omit<ApiResponse<null>, 'timestamp' | 'path'> {
    return {
      success: false,
      data: null,
      error: {
        code,
        message,
        details,
      },
    };
  }

  static paginated<T>(
    data: T[],
    total: number,
    page: number,
    limit: number,
    message?: string,
  ): Omit<PaginatedApiResponse<T>, 'timestamp' | 'path'> {
    return {
      success: true,
      data,
      message: message || 'Data retrieved successfully',
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
