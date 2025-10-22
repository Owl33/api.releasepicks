import type { VercelRequest, VercelResponse } from '@vercel/node';

const DEFAULT_TIMEOUT_MS = 1000 * 60 * 5;

function log(message: string, payload?: Record<string, unknown>) {
  if (payload) {
    console.log(`[CronProxy] ${message}`, JSON.stringify(payload));
    return;
  }
  console.log(`[CronProxy] ${message}`);
}

function buildTargetUrl(): URL {
  const baseUrl = process.env.PIPELINE_BASE_URL ?? process.env.API_BASE_URL;
  if (baseUrl && baseUrl.trim().length > 0) {
    return new URL('/api/pipeline/cron/steam-maintenance', baseUrl.trim());
  }

  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (!vercelUrl || vercelUrl.trim().length === 0) {
    throw new Error('PIPELINE_BASE_URL 환경 변수가 필요합니다. ');
  }

  const normalized = vercelUrl.startsWith('http')
    ? vercelUrl
    : `https://${vercelUrl}`;

  return new URL('/api/pipeline/cron/steam-maintenance', normalized);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  log('요청 수신', { method: req.method, url: req.url });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ statusCode: 405, message: '메서드가 허용되지 않습니다.' });
    return;
  }

  const cronKey = process.env.PIPELINE_CRON_KEY;
  if (!cronKey || cronKey.trim().length === 0) {
    log('환경 변수 PIPELINE_CRON_KEY 미설정');
    res.status(500).json({ statusCode: 500, message: 'PIPELINE_CRON_KEY 환경 변수가 설정되어 있지 않습니다.' });
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = buildTargetUrl();
    log('타깃 URL 생성 성공', { target: targetUrl.toString() });
  } catch (error) {
    log('타깃 URL 생성 실패', { error: (error as Error).message });
    res.status(500).json({ statusCode: 500, message: (error as Error).message });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    log('파이프라인 엔드포인트 호출 시작');
    const response = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'x-cron-key': cronKey,
        'user-agent': 'releasepicks-cron-proxy/1.0',
      },
      signal: controller.signal,
    });

    log('파이프라인 엔드포인트 응답 수신', {
      status: response.status,
      ok: response.ok,
    });

    const bodyText = await response.text();

    res.status(response.status);
    if (response.headers.has('content-type')) {
      res.setHeader('content-type', response.headers.get('content-type') as string);
    }
    res.send(bodyText);
    log('프록시 응답 전송 완료', { status: response.status });
  } catch (error) {
    log('파이프라인 엔드포인트 호출 실패', { error: (error as Error).message });
    res.status(502).json({
      statusCode: 502,
      message: 'Cron 프록시 호출 중 오류가 발생했습니다.',
      error: (error as Error).message,
    });
  } finally {
    clearTimeout(timeout);
    log('요청 처리 종료');
  }
}
