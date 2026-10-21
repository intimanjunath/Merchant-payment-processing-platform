import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { countAttempt, forgiveAttempt, type ThrottleKey } from '@payments/db';
import type { Logger } from '@payments/observability';
import type { Pool } from 'pg';

import { ApiError } from '../common/api-error';
import type { ApiConfig } from '../config/config';
import { CONFIG, DB_POOL, LOGGER } from '../tokens';

/**
 * Fixed-window limits on failed logins per email and per client IP, stored in
 * PostgreSQL so they hold across API instances (design §4). Every attempt is
 * counted before the password check and a successful one is taken back, so
 * only failures remain counted.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Counts this attempt; throws 429 with Retry-After if it goes over either limit. */
  async assertAllowed(email: string, ip: string): Promise<ThrottleKey> {
    const key = this.keyFor(email, ip);
    const attempts = await countAttempt(this.pool, key);
    const { maxPerEmail, maxPerIp } = this.config.loginThrottle;

    const scope =
      attempts.email > maxPerEmail ? 'email' : attempts.ip > maxPerIp ? 'ip' : undefined;
    if (scope) {
      const retryAfter = this.secondsLeftIn(key.windowStart);
      this.logger.warn({ event: 'auth.throttled', scope, retryAfter }, 'Login throttled');
      throw new ApiError(429, 'RATE_LIMITED', 'Too many failed login attempts. Try again later.', {
        headers: { 'Retry-After': String(retryAfter) },
      });
    }
    return key;
  }

  async recordSuccess(key: ThrottleKey): Promise<void> {
    await forgiveAttempt(this.pool, key);
  }

  private keyFor(email: string, ip: string): ThrottleKey {
    const windowMs = this.config.loginThrottle.windowSeconds * 1000;
    return {
      emailHash: sha256(email.trim().toLowerCase()),
      ipHash: sha256(ip),
      windowStart: new Date(Math.floor(Date.now() / windowMs) * windowMs),
    };
  }

  private secondsLeftIn(windowStart: Date): number {
    const windowEnd = windowStart.getTime() + this.config.loginThrottle.windowSeconds * 1000;
    return Math.max(1, Math.ceil((windowEnd - Date.now()) / 1000));
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
