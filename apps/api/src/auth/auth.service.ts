import { Inject, Injectable } from '@nestjs/common';
import {
  type ClientKind,
  createSession,
  findActiveSession,
  findMerchantByEmail,
  type Merchant,
  revokeSession,
} from '@payments/db';
import type { Logger } from '@payments/observability';
import argon2 from 'argon2';
import type { Pool } from 'pg';

import { ApiError } from '../common/api-error';
import type { ApiConfig } from '../config/config';
import { CONFIG, DB_POOL, LOGGER } from '../tokens';
import type { AuthContext } from './auth-context';
import { signSessionToken, type TokenSettings, verifySessionToken } from './session-token';

export interface LoginResult {
  merchant: Merchant;
  session: { id: string; expiresAt: Date };
  token: string;
}

export type AuthRejection = 'expired' | 'invalid' | 'session_not_active';

@Injectable()
export class AuthService {
  private readonly tokens: TokenSettings;
  // Verified against when the email is unknown, so a failed login takes the same
  // time whether or not the account exists.
  private readonly dummyHash: Promise<string>;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.tokens = config.jwt;
    this.dummyHash = argon2.hash('no-account-has-this-password', { type: argon2.argon2id });
  }

  /** Checks credentials and opens a session. Every failure looks the same to the caller. */
  async login(email: string, password: string, clientKind: ClientKind): Promise<LoginResult> {
    const merchant = await findMerchantByEmail(this.pool, email.trim());
    const hash = merchant?.passwordHash ?? (await this.dummyHash);
    const passwordMatches = await argon2.verify(hash, password);

    if (!merchant || !passwordMatches) {
      this.logger.warn(
        { event: 'auth.login.failed', clientKind, merchantId: merchant?.id },
        'Login failed',
      );
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    const session = await createSession(this.pool, {
      merchantId: merchant.id,
      clientKind,
      ttlSeconds: this.config.sessionTtlSeconds,
    });
    const token = signSessionToken(
      this.tokens,
      { merchantId: merchant.id, sessionId: session.id },
      session.expiresAt,
    );
    this.logger.info(
      { event: 'auth.login.succeeded', clientKind, merchantId: merchant.id, sessionId: session.id },
      'Login succeeded',
    );
    return {
      merchant: { id: merchant.id, email: merchant.email, name: merchant.name },
      session,
      token,
    };
  }

  /** Verifies the token, then that its session is still active and belongs to its merchant. */
  async authenticate(
    token: string,
    via: AuthContext['via'],
  ): Promise<{ auth: AuthContext } | { rejected: AuthRejection }> {
    const verified = verifySessionToken(this.tokens, token);
    if ('rejected' in verified) return verified;

    const session = await findActiveSession(this.pool, verified.claims);
    if (!session) return { rejected: 'session_not_active' };

    return {
      auth: {
        merchant: session.merchant,
        session: { id: session.id, clientKind: session.clientKind, expiresAt: session.expiresAt },
        via,
      },
    };
  }

  async logout(auth: AuthContext): Promise<void> {
    await revokeSession(this.pool, auth.session.id);
    this.logger.info(
      { event: 'auth.logout', merchantId: auth.merchant.id, sessionId: auth.session.id },
      'Session revoked',
    );
  }
}
