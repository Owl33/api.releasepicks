// src/common/http/axios-client.ts
import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  AxiosError,
  InternalAxiosRequestConfig,
} from 'axios';

/** 공통 에러 코드 */
export type HttpErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMIT'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'NETWORK_ERROR'
  | 'INTERNAL_ERROR';

export interface HttpErrorShape {
  statusCode: number;
  timestamp: string;
  path?: string;
  requestId?: string;
  message: string;
  code: HttpErrorCode;
  error?: {
    details?: any; // 개발/스테이징에서만 풍부하게
  };
  meta?: {
    attempt?: number;
    retries?: number;
    elapsedMs?: number;
    baseURL?: string;
  };
}

/** 재시도 옵션 */
export interface RetryOptions {
  retries: number; // 총 시도 횟수 (기본 3)
  baseDelayMs: number; // 지수 백오프 기본 (기본 300ms)
  maxDelayMs: number; // 백오프 상한 (기본 5000ms)
  retryOnStatuses?: number[]; // 기본: 429 + 5xx
  respectRetryAfter?: boolean; // true면 Retry-After 헤더 존중
}

/** 클라이언트 생성 옵션 */
export interface HttpClientOptions {
  baseURL?: string;
  timeoutMs?: number; // 요청 타임아웃
  headers?: Record<string, string>;
  userAgent?: string;
  requestId?: string; // 상위 요청ID를 전파하고 싶을 때
  logger?: { log: (m: string) => void; error: (m: string) => void }; // Nest Logger 등
  retry?: Partial<RetryOptions>;
  // 프록시 등이 필요하면 axios config로 직접 넘겨도 됨
  axiosConfigOverride?: AxiosRequestConfig;
}

/** 성공 응답 표준 래퍼 (원하면 그대로 사용, 아니면 AxiosResponse를 그대로 써도 됨) */
export interface Ok<T = any> {
  statusCode: number;
  timestamp: string;
  path?: string;
  requestId?: string;
  message: string; // "OK"
  code: 'OK';
  data: T;
  meta?: {
    elapsedMs: number;
    baseURL?: string;
  };
}

/** 내부 유틸: sleep */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 기본 재시도 설정 */
const defaultRetry: RetryOptions = {
  retries: 3,
  baseDelayMs: 300,
  maxDelayMs: 5000,
  retryOnStatuses: [429, 500, 502, 503, 504],
  respectRetryAfter: true,
};

/** 상태코드 → 에러코드 매핑 */
function mapStatusToCode(status?: number): HttpErrorCode {
  if (!status) return 'NETWORK_ERROR';
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408) return 'UPSTREAM_TIMEOUT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'INTERNAL_ERROR';
}

/** 공통 에러 객체 생성 */
function toHttpErrorShape(
  error: AxiosError,
  path?: string,
  requestId?: string,
  attempt?: number,
  retries?: number,
  elapsedMs?: number,
  baseURL?: string,
): HttpErrorShape {
  const status = error.response?.status ?? 500;
  const code = mapStatusToCode(status);
  const message =
    (error.response?.data as any)?.message ||
    error.message ||
    'Upstream request failed';
  const details =
    process.env.NODE_ENV && process.env.NODE_ENV !== 'production'
      ? {
          axiosMessage: error.message,
          responseData: error.response?.data,
          responseHeaders: error.response?.headers,
        }
      : undefined;

  return {
    statusCode: status,
    timestamp: new Date().toISOString(),
    path,
    requestId,
    message,
    code,
    error: details ? { details } : undefined,
    meta: { attempt, retries, elapsedMs, baseURL },
  };
}

/** 공통 성공 래퍼 */
function toOk<T>(
  data: T,
  status: number,
  path?: string,
  requestId?: string,
  elapsedMs?: number,
  baseURL?: string,
): Ok<T> {
  return {
    statusCode: status,
    timestamp: new Date().toISOString(),
    path,
    requestId,
    message: 'OK',
    code: 'OK',
    data,
    meta: { elapsedMs: elapsedMs ?? 0, baseURL },
  };
}

/** Axios 기반 공용 HTTP 클라이언트 */
export class HttpClient {
  private axios: AxiosInstance;
  private logger?: HttpClientOptions['logger'];
  private retry: RetryOptions;
  private baseURL?: string;
  private requestId?: string;

  constructor(opts: HttpClientOptions = {}) {
    this.logger = opts.logger;
    this.retry = { ...defaultRetry, ...(opts.retry ?? {}) };
    this.baseURL = opts.baseURL;
    this.requestId = opts.requestId;

    this.axios = axios.create({
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 30000,
      headers: {
        'User-Agent':
          opts.userAgent ?? 'GameCalendarBot/1.0 (+https://your.domain)',
        ...(opts.headers ?? {}),
      },
      ...(opts.axiosConfigOverride ?? {}),
    });

    // Request interceptor: x-request-id 전파 & 로깅
    this.axios.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        if (this.requestId && !config.headers['x-request-id']) {
          config.headers['x-request-id'] = this.requestId;
        }
        const url = (config.baseURL || '') + (config.url || '');
        this.logger?.log?.(
          `➡️ [REQ] ${config.method?.toUpperCase()} ${url} ` +
            `| params=${JSON.stringify(config.params ?? {})} | headers=${JSON.stringify(safeHeaders(config.headers))}`,
        );
        (config as any).__startAt = Date.now();
        return config;
      },
      (error) => Promise.reject(error),
    );

    // Response interceptor: 로깅
    this.axios.interceptors.response.use(
      (res: AxiosResponse) => {
        const start = (res.config as any).__startAt ?? Date.now();
        const elapsed = Date.now() - start;
        const url = (res.config.baseURL || '') + (res.config.url || '');
        this.logger?.log?.(`✅ [RES] ${res.status} ${url} | ${elapsed}ms`);
        return res;
      },
      (error: AxiosError) => {
        try {
          const cfg: any = error.config || {};
          const start = cfg.__startAt ?? Date.now();
          const elapsed = Date.now() - start;
          const url = (cfg.baseURL || '') + (cfg.url || '') || '(unknown)';
          const status = error.response?.status ?? 'NO_HTTP';
          this.logger?.error?.(
            `❌ [ERR] ${status} ${url} | ${elapsed}ms | ${error.message}`,
          );
        } catch {
          /* noop */
        }
        return Promise.reject(error);
      },
    );
  }

  /** 내부: 재시도 가능한지 판단 */
  private shouldRetry(error: AxiosError, attempt: number): boolean {
    const status = error.response?.status;
    const isNetwork =
      !!error.code &&
      [
        'ECONNABORTED',
        'ENETDOWN',
        'ENOTFOUND',
        'ECONNRESET',
        'EAI_AGAIN',
        'ETIMEDOUT',
      ].includes(error.code);
    const retryStatuses =
      this.retry.retryOnStatuses ?? defaultRetry.retryOnStatuses!;
    const statusRetry = status ? retryStatuses.includes(status) : false;
    return attempt < this.retry.retries && (isNetwork || statusRetry);
  }

  /** 내부: 지수 백오프 + 지터 */
  private async backoffDelay(attempt: number, retryAfterHeader?: string) {
    if (this.retry.respectRetryAfter && retryAfterHeader) {
      const retryAfterSec = Number(retryAfterHeader);
      if (!Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
        const ms = Math.min(retryAfterSec * 1000, this.retry.maxDelayMs);
        await sleep(ms);
        return;
      }
      // HTTP-date 형식은 생략. 필요 시 파싱 추가.
    }
    const base = this.retry.baseDelayMs * Math.pow(2, attempt - 1); // 1,2,4배…
    const jitter = Math.floor(Math.random() * (base / 2));
    const ms = Math.min(base + jitter, this.retry.maxDelayMs);
    await sleep(ms);
  }

  /** 공통 요청 (GET/POST 등 모두 이 함수를 사용) */
  async request<T = any>(
    config: AxiosRequestConfig,
    opts?: { wrapOk?: boolean; pathForMeta?: string },
  ): Promise<Ok<T> | AxiosResponse<T>> {
    const started = Date.now();
    const urlForMeta = (this.baseURL || '') + (config.url || '');
    let lastError: AxiosError | null = null;

    for (let attempt = 1; attempt <= this.retry.retries; attempt++) {
      try {
        const res = await this.axios.request<T>(config);
        const elapsed = Date.now() - started;

        if (opts?.wrapOk === false) {
          // AxiosResponse 그대로 반환
          return res;
        }
        return toOk<T>(
          res.data,
          res.status,
          opts?.pathForMeta ?? urlForMeta,
          this.requestId,
          elapsed,
          this.baseURL,
        );
      } catch (e) {
        const err = e as AxiosError;
        lastError = err;

        // 재시도 여부 판단
        if (this.shouldRetry(err, attempt)) {
          const retryAfter = err.response?.headers?.['retry-after'] as
            | string
            | undefined;
          this.logger?.log?.(
            `🔁 재시도 ${attempt}/${this.retry.retries - 1} (status=${err.response?.status ?? err.code})`,
          );
          await this.backoffDelay(attempt, retryAfter);
          continue;
        }
        break;
      }
    }

    // 최종 실패 → 표준 에러로 throw
    const elapsed = Date.now() - started;
    throw toHttpErrorShape(
      lastError!,
      opts?.pathForMeta ?? urlForMeta,
      this.requestId,
      this.retry.retries,
      this.retry.retries,
      elapsed,
      this.baseURL,
    );
  }

  // 편의 메서드들
  get<T = any>(url: string, config?: AxiosRequestConfig, wrapOk = true) {
    return this.request<T>(
      { ...config, method: 'GET', url },
      { wrapOk, pathForMeta: url },
    );
  }
  post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
    wrapOk = true,
  ) {
    return this.request<T>(
      { ...config, method: 'POST', url, data },
      { wrapOk, pathForMeta: url },
    );
  }
  put<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
    wrapOk = true,
  ) {
    return this.request<T>(
      { ...config, method: 'PUT', url, data },
      { wrapOk, pathForMeta: url },
    );
  }
  delete<T = any>(url: string, config?: AxiosRequestConfig, wrapOk = true) {
    return this.request<T>(
      { ...config, method: 'DELETE', url },
      { wrapOk, pathForMeta: url },
    );
  }
}

/** 헤더 로깅 시 민감 키 마스킹 */
function safeHeaders(h?: any) {
  if (!h) return {};
  const lower = Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const maskKeys = [
    'authorization',
    'x-api-key',
    'api-key',
    'cookie',
    'set-cookie',
  ];
  for (const k of maskKeys) {
    if (lower[k]) lower[k] = '[masked]';
  }
  return lower;
}

/* ============================
 * 사용 예시
 * ============================
 *
 * // 1) Steam 커뮤니티 검색 (HTML 페이지)
 * const steamHttp = new HttpClient({
 *   baseURL: 'https://steamcommunity.com',
 *   timeoutMs: 30000,
 *   userAgent: 'Mozilla/5.0 ...', // 필요 시
 *   requestId: req?.requestId,    // Nest에서 전달 가능
 *   logger: new Logger('HTTP'),   // Nest Logger 주입 가능
 *   retry: { retries: 4, baseDelayMs: 400 }
 * });
 *
 * const html = await steamHttp.get<string>('/search/groups', {
 *   params: { text: 'nioh 3' },
 *   // HTML이므로 axios responseType: 'text'가 기본
 * });
 * // html.data (wrapOk=true면 .data.data 문자열)
 *
 * // 2) RAWG API (JSON)
 * const rawg = new HttpClient({
 *   baseURL: 'https://api.rawg.io/api',
 *   headers: { 'Accept': 'application/json' },
 *   retry: { retries: 3 }
 * });
 *
 * const games = await rawg.get<{ results: any[] }>('/games', {
 *   params: { key: process.env.RAWG_KEY, search: 'Nioh 3' }
 * });
 *
 * // 3) AxiosResponse가 필요하면 wrapOk=false
 * const res = await rawg.get('/games', { params: { key: '...' } }, false);
 * console.log(res.status, res.data);
 */
