import { createHmac } from 'node:crypto';

/**
 * The CSRF token is an HMAC of the session ID: bound to the session, the same
 * after a page reload, and nothing to store (spec §4.1).
 */
export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('base64url');
}
