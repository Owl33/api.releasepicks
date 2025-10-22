import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class ServiceRoleGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const primaryKey = this.resolvePrimaryKey();
    const cronKey = this.resolveCronKey();

    if (!primaryKey && !cronKey) {
      throw new UnauthorizedException('Service role key is not configured.');
    }

    const headerKey = this.extractHeaderKey(request);
    if (headerKey) {
      if (this.matchesAllowedKey(headerKey, primaryKey, cronKey)) return true;
      throw new ForbiddenException('Invalid service role key.');
    }

    const cronToken = this.extractCronToken(request);
    if (cronToken && cronKey && cronToken === cronKey) {
      return true;
    }

    throw new UnauthorizedException('Missing service role credentials.');
  }

  private resolvePrimaryKey(): string | null {
    const pipelineKey = (this.configService.get<string>('PIPELINE_SERVICE_KEY') ?? '').trim();
    if (pipelineKey) return pipelineKey;

    const legacyKey = (this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
    return legacyKey || null;
  }

  private resolveCronKey(): string | null {
    const cronKey = (this.configService.get<string>('PIPELINE_CRON_KEY') ?? '').trim();
    return cronKey || null;
  }

  private matchesAllowedKey(
    candidate: string,
    primaryKey: string | null,
    cronKey: string | null,
  ): boolean {
    if (primaryKey && candidate === primaryKey) return true;
    if (cronKey && candidate === cronKey) return true;
    return false;
  }

  private extractHeaderKey(request: Request): string | null {
    const headerCandidates = [
      request.headers['x-service-key'],
      request.headers['x-service-role-key'],
      request.headers['apikey'],
    ];

    for (const candidate of headerCandidates) {
      const normalized = this.normalizeHeaderValue(candidate);
      if (normalized) return normalized;
    }

    return null;
  }

  private extractCronToken(request: Request): string | null {
    const headerToken = this.normalizeHeaderValue(request.headers['x-cron-key']);
    if (headerToken) return headerToken;

    const query = request.query ?? {};
    const possibleKeys = ['cronKey', 'cron_key', 'cronToken', 'cron_token'];
    for (const key of possibleKeys) {
      const value = query[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
      if (Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (typeof first === 'string' && first.trim().length > 0) {
          return first.trim();
        }
      }
    }

    return null;
  }

  private normalizeHeaderValue(value: string | string[] | undefined): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (typeof first === 'string') {
        const trimmed = first.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
    }
    return null;
  }
}
