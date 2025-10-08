// api/index.ts
import type { IncomingMessage, ServerResponse } from 'http';
import { buildServer } from '../src/main'; // 빌드 산출물을 쓸 거면 '../dist/main'

let cachedServer: any;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!cachedServer) {
    cachedServer = await buildServer();
  }
  return cachedServer(req, res); // Express requestListener 호출
}
