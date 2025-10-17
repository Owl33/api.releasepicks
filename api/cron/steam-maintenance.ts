import type { VercelRequest, VercelResponse } from '@vercel/node';

const BASE_URL = process.env.INTERNAL_BASE_URL ?? process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

async function invokeEndpoint(
  path: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-key': SERVICE_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed (${response.status}) ${path}: ${text}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  if (!SERVICE_KEY) {
    res
      .status(500)
      .json({ ok: false, message: 'SUPABASE_SERVICE_ROLE_KEY missing' });
    return;
  }

  try {
    await invokeEndpoint('/api/pipeline/refresh/steam', {
      limit: 1000,
      dryRun: false,
    });

    await invokeEndpoint('/api/pipeline/steam/new', {
      mode: 'operational',
      limit: 1000,
      dryRun: false,
    });

    res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error('[cron steam-maintenance] failed', error);
    res.status(500).json({ ok: false, message: error?.message ?? 'Unknown error' });
  }
}
