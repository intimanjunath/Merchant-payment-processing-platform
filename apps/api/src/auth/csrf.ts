import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Request } from 'express';

/**
 * The CSRF token is an HMAC of the session ID: bound to the session, the same
 * after a page reload, and nothing to store (spec §4.1).
 */
export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('base64url');
}

export function csrfTokenMatches(secret: string, sessionId: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expected = Buffer.from(csrfTokenFor(secret, sessionId));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * The browser origin of a request: the Origin header, or failing that the origin
 * of the Referer. Undefined when neither is sent (typical of non-browser clients).
 */
export function requestOrigin(req: Request): string | undefined {
  const origin = req.get('origin');
  if (origin) return origin;
  const referer = req.get('referer');
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return 'invalid';
  }
}

/** A request with no browser origin passes; one from an origin not on the list doesn't. */
export function originAllowed(req: Request, allowedOrigins: readonly string[]): boolean {
  const origin = requestOrigin(req);
  return origin === undefined || allowedOrigins.includes(origin);
}
