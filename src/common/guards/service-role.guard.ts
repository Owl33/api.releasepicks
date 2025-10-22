import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ServiceRoleGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const serviceKey = this.configService.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );

    if (!serviceKey || serviceKey.trim() === '') {
      throw new UnauthorizedException('Service role key is not configured.');
    }

    const headerKey = this.extractKey(request);
    if (!headerKey) {
      throw new UnauthorizedException('Missing service role key header.');
    }

    if (headerKey !== serviceKey) {
      throw new ForbiddenException('Invalid service role key.');
    }

    return true;
  }

  private extractKey(request: {
    headers: Record<string, string | undefined>;
  }): string | null {
    const headerKey =
      request.headers['x-service-key'] ??
      request.headers['x-service-role-key'] ??
      request.headers['apikey'];

    if (headerKey && headerKey.trim().length > 0) {
      return headerKey.trim();
    }

    return null;
  }
}
