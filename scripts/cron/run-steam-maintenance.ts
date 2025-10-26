import 'dotenv/config';
import axios, { AxiosError } from 'axios';

interface CliOptions {
  endpoint?: string;
  timeoutMs?: number;
  dryRun?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30분

// 간단한 CLI 인자 파서 (--key=value 형태만 지원)
function parseCliOptions(): CliOptions {
  const options: CliOptions = {};
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('--endpoint=')) {
      options.endpoint = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--timeoutMs=')) {
      const value = Number(arg.split('=')[1]);
      if (!Number.isNaN(value)) {
        options.timeoutMs = value;
      }
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

function resolveEndpoint(cli: CliOptions): string {
  if (cli.endpoint && cli.endpoint.trim().length > 0) {
    return cli.endpoint.trim();
  }
  const direct = process.env.STEAM_MAINTENANCE_ENDPOINT;
  if (direct && direct.trim().length > 0) {
    return direct.trim();
  }
  const base = process.env.PIPELINE_BASE_URL ?? process.env.API_BASE_URL;
  if (base && base.trim().length > 0) {
    return new URL('/api/cron/steam-maintenance', base.trim()).toString();
  }
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim().length > 0) {
    const normalized = vercelUrl.startsWith('http') ? vercelUrl : `https://${vercelUrl}`;
    return new URL('/api/cron/steam-maintenance', normalized).toString();
  }
  throw new Error('엔드포인트를 결정할 수 없습니다. 환경 변수(STEAM_MAINTENANCE_ENDPOINT 등)를 확인하세요.');
}

async function main() {
  const cli = parseCliOptions();
  const endpoint = resolveEndpoint(cli);
  const cronKey = (process.env.PIPELINE_CRON_KEY ?? '').trim();
  if (!cronKey) {
    throw new Error('PIPELINE_CRON_KEY가 설정되어 있어야 합니다. GitHub Secrets 또는 .env를 확인하세요.');
  }

  if (cli.dryRun) {
    console.log('[Cron] dry-run 모드이므로 HTTP 호출을 생략합니다.', { endpoint });
    return;
  }

  const timeoutMs = cli.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  console.log('[Cron] Steam 유지보수 호출 시작', {
    endpoint,
    timeoutMs,
    timestamp: new Date().toISOString(),
  });

  const startedAt = Date.now();
  try {
    const response = await axios.get(endpoint, {
      headers: {
        'x-cron-key': cronKey,
        'user-agent': 'game-calendar-gh-cron/1.0',
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    const durationMs = Date.now() - startedAt;
    console.log('[Cron] HTTP 응답 수신', {
      status: response.status,
      durationMs,
    });

    if (typeof response.data === 'string') {
      console.log('[Cron] 응답 본문(문자열)', response.data);
    } else {
      console.log('[Cron] 응답 본문(JSON)', JSON.stringify(response.data, null, 2));
    }

    if (response.status >= 400) {
      throw new Error(`Steam 유지보수 호출이 실패했습니다. status=${response.status}`);
    }

    console.log('[Cron] Steam 유지보수 호출 완료', {
      durationMs,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error instanceof AxiosError) {
      console.error('[Cron] Axios 에러 발생', {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        durationMs,
        data: error.response?.data,
      });
    } else {
      console.error('[Cron] 일반 에러 발생', {
        message: (error as Error).message,
        stack: (error as Error).stack,
        durationMs,
      });
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[Cron] 예상치 못한 에러로 종료됩니다.', error);
  process.exit(1);
});
