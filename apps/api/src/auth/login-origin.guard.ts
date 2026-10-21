import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@payments/observability';
import type { Request } from 'express';

import { ApiError } from '../common/api-error';
import type { ApiConfig } from '../config/config';
import { CONFIG, LOGGER } from '../tokens';
import { originAllowed } from './csrf';

/**
 * Stops another site from posting a form to /auth/login and signing the browser
 * into an account of the attacker's choosing (login CSRF). Requests with no
 * browser origin, such as API clients, are unaffected.
 */
@Injectable()
export class LoginOriginGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (originAllowed(req, this.config.allowedOrigins)) return true;
    this.logger.warn(
      { event: 'auth.csrf_rejected', reason: 'login_origin_not_allowed' },
      'Cross-site login rejected',
    );
    throw new ApiError(403, 'CSRF_REJECTED', 'The request was rejected.');
  }
}
