import jwt from 'jsonwebtoken';

export interface TokenSettings {
  secret: string;
  issuer: string;
  audience: string;
}

export interface SessionClaims {
  merchantId: string;
  sessionId: string;
}

export type TokenRejection = 'expired' | 'invalid';

const ALGORITHM = 'HS256';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signs a session token whose expiry matches the session row's expires_at. */
export function signSessionToken(
  settings: TokenSettings,
  claims: SessionClaims,
  expiresAt: Date,
): string {
  return jwt.sign(
    { sid: claims.sessionId, exp: Math.floor(expiresAt.getTime() / 1000) },
    settings.secret,
    {
      algorithm: ALGORITHM,
      issuer: settings.issuer,
      audience: settings.audience,
      subject: claims.merchantId,
    },
  );
}

/**
 * Checks signature, algorithm (HS256 only, so `none` or a swapped algorithm is
 * refused), issuer, audience and expiry, and that both IDs are UUIDs before
 * they are ever used in SQL. Never throws.
 */
export function verifySessionToken(
  settings: TokenSettings,
  token: string,
): { claims: SessionClaims } | { rejected: TokenRejection } {
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, settings.secret, {
      algorithms: [ALGORITHM],
      issuer: settings.issuer,
      audience: settings.audience,
    });
  } catch (error) {
    return { rejected: error instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' };
  }
  if (typeof payload === 'string') return { rejected: 'invalid' };

  const { sub, sid, exp } = payload as { sub?: unknown; sid?: unknown; exp?: unknown };
  if (typeof exp !== 'number' || !isUuid(sub) || !isUuid(sid)) {
    return { rejected: 'invalid' };
  }
  return { claims: { merchantId: sub, sessionId: sid } };
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
