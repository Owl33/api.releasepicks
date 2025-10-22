import type { VercelRequest, VercelResponse } from '@vercel/node';

const DEFAULT_TIMEOUT_MS = 1000 * 60 * 5;

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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ statusCode: 405, message: '메서드가 허용되지 않습니다.' });
    return;
  }

  const cronKey = process.env.PIPELINE_CRON_KEY;
  if (!cronKey || cronKey.trim().length === 0) {
    res.status(500).json({ statusCode: 500, message: 'PIPELINE_CRON_KEY 환경 변수가 설정되어 있지 않습니다.' });
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = buildTargetUrl();
  } catch (error) {
    res.status(500).json({ statusCode: 500, message: (error as Error).message });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'x-cron-key': cronKey,
        'user-agent': 'releasepicks-cron-proxy/1.0',
      },
      signal: controller.signal,
    });

    const bodyText = await response.text();

    res.status(response.status);
    if (response.headers.has('content-type')) {
      res.setHeader('content-type', response.headers.get('content-type') as string);
    }
    res.send(bodyText);
  } catch (error) {
    res.status(502).json({
      statusCode: 502,
      message: 'Cron 프록시 호출 중 오류가 발생했습니다.',
      error: (error as Error).message,
    });
  } finally {
    clearTimeout(timeout);
  }
}
