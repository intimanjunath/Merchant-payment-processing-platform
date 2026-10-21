import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { addToContext, type Logger } from '@payments/observability';
import type { Request } from 'express';

import { ApiError } from '../common/api-error';
import { LOGGER } from '../tokens';
import { type AuthContext, type AuthenticatedRequest, SESSION_COOKIE } from './auth-context';
import { AuthService } from './auth.service';

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

/**
 * Accepts a session token from the Authorization header or the session cookie.
 * When an Authorization header is present it is the only credential considered,
 * so a bad header is never rescued by a good cookie.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const credential = readCredential(req);
    if (!credential) {
      return this.reject(credential === null ? 'malformed_authorization' : 'missing');
    }

    const result = await this.auth.authenticate(credential.token, credential.via);
    if ('rejected' in result) {
      return this.reject(result.rejected);
    }

    (req as AuthenticatedRequest).auth = result.auth;
    addToContext({ merchantId: result.auth.merchant.id });
    return true;
  }

  private reject(reason: string): never {
    this.logger.debug({ event: 'auth.rejected', reason }, 'Request not authenticated');
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }
}

/** undefined: no credential at all; null: an Authorization header that isn't a Bearer token. */
function readCredential(
  req: Request,
): { token: string; via: AuthContext['via'] } | null | undefined {
  const header = req.headers.authorization;
  if (header !== undefined) {
    const match = BEARER.exec(header);
    return match?.[1] ? { token: match[1], via: 'bearer' } : null;
  }
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const cookie = cookies?.[SESSION_COOKIE];
  return typeof cookie === 'string' && cookie.length > 0
    ? { token: cookie, via: 'cookie' }
    : undefined;
}
