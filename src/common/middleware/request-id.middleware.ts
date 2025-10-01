import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';

export const REQ_ID_HEADER = 'x-request-id';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    const existing = req.headers[REQ_ID_HEADER] || req.headers['x-requestid'];
    const id = (existing && String(existing)) || randomUUID();
    req.requestId = id;
    res.setHeader(REQ_ID_HEADER, id);
    next();
  }
}
