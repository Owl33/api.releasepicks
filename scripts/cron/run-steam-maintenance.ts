import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { PipelineController } from '../../src/pipeline/pipeline.controller';
import { SteamRefreshDto } from '../../src/pipeline/dto/steam-refresh.dto';
import { SteamNewDto } from '../../src/pipeline/dto/steam-new.dto';

interface CliOptions {
  dryRun?: boolean;
  refreshLimit?: number;
  newLimit?: number;
}

const DEFAULT_REFRESH_LIMIT = 1000;
const DEFAULT_NEW_LIMIT = 1000;

// 간단한 CLI 인자 파서 (--key=value 형태만 지원)
function parseCliOptions(): CliOptions {
  const options: CliOptions = {};
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('--refreshLimit=')) {
      const value = Number(arg.split('=')[1]);
      if (!Number.isNaN(value)) {
        options.refreshLimit = value;
      }
      continue;
    }
    if (arg.startsWith('--newLimit=')) {
      const value = Number(arg.split('=')[1]);
      if (!Number.isNaN(value)) {
        options.newLimit = value;
      }
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

function resolveLimit(
  cliValue: number | undefined,
  envKey: string,
  fallback: number,
): number {
  if (typeof cliValue === 'number' && !Number.isNaN(cliValue)) {
    return cliValue;
  }
  const envValueRaw = process.env[envKey];
  if (envValueRaw) {
    const parsed = Number(envValueRaw);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

async function runDirectMode(cli: CliOptions) {
  const refreshLimit = resolveLimit(
    cli.refreshLimit,
    'STEAM_CRON_REFRESH_LIMIT',
    DEFAULT_REFRESH_LIMIT,
  );
  const newLimit = resolveLimit(
    cli.newLimit,
    'STEAM_CRON_NEW_LIMIT',
    DEFAULT_NEW_LIMIT,
  );
  const dryRun = cli.dryRun ?? (process.env.STEAM_CRON_DRY_RUN === 'true');

  console.log('[Cron][Direct] Nest 애플리케이션 컨텍스트 부팅', {
    refreshLimit,
    newLimit,
    dryRun,
  });

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  const logger = new Logger('SteamCronDirect');

  const overallStart = Date.now();

  try {
    const pipeline = app.get(PipelineController);
    const refreshDto = Object.assign(new SteamRefreshDto(), {
      limit: refreshLimit,
      dryRun,
    });
    const newDto = Object.assign(new SteamNewDto(), {
      mode: 'operational',
      limit: newLimit,
      dryRun,
    });

    const refreshStart = Date.now();
    logger.log('출시 윈도우 갱신 실행 시작');
    const refreshResult = await pipeline.executeSteamRefresh(refreshDto);
    logger.log('출시 윈도우 갱신 실행 완료', {
      durationMs: Date.now() - refreshStart,
      dryRun,
      limit: refreshLimit,
    });

    const newStart = Date.now();
    logger.log('Steam 신규 탐지 실행 시작');
    const steamNewResult = await pipeline.executeSteamNew(newDto);
    logger.log('Steam 신규 탐지 실행 완료', {
      durationMs: Date.now() - newStart,
      dryRun,
      limit: newLimit,
    });

    console.log('[Cron][Direct] 전체 실행 완료', {
      totalDurationMs: Date.now() - overallStart,
    });
    console.log('[Cron][Direct] 요약 응답', JSON.stringify({
      refresh: refreshResult,
      steamNew: steamNewResult,
    }, null, 2));
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Direct 모드 실행 중 에러: ${error.message}`, error.stack);
    } else {
      logger.error('Direct 모드 실행 중 알 수 없는 에러', JSON.stringify(error));
    }
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

async function main() {
  const cli = parseCliOptions();
  await runDirectMode(cli);
}

main().catch((error) => {
  console.error('[Cron] 예상치 못한 에러로 종료됩니다.', error);
  process.exit(1);
});
