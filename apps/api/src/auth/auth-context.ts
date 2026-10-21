import type { ClientKind, Merchant } from '@payments/db';
import type { Request } from 'express';

/** Who is calling, set on the request by AuthGuard. */
export interface AuthContext {
  merchant: Merchant;
  session: { id: string; clientKind: ClientKind; expiresAt: Date };
  /** How the token arrived. CSRF checks apply only to the cookie path (step 6). */
  via: 'cookie' | 'bearer';
}

export type AuthenticatedRequest = Request & { auth: AuthContext };

export const SESSION_COOKIE = 'pp_session';
