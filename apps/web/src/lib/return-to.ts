import type { SessionState } from './session-controller';

/** Router state that sign-in reads: the page to go back to, and whose page it was. */
export interface ReturnTo {
  from: string;
  /** The merchant whose session ended on that page; null if no one was signed in. */
  merchantId: string | null;
}

/**
 * What a signed-out visit to a protected page hands to sign-in. After an
 * explicit sign-out nothing: the page's URL holds the previous merchant's
 * filters and search, and the next person starts fresh. After an expired
 * session or a first visit, the page, so signing in picks up where it was.
 */
export function returnToFor(
  state: Extract<SessionState, { status: 'signed_out' }>,
  location: { pathname: string; search: string },
): ReturnTo | null {
  if (state.reason === 'signed_out') return null;
  return { from: location.pathname + location.search, merchantId: state.previousMerchantId };
}

/** Where to go after signing in as `merchantId`: back, but only to that merchant's own page. */
export function returnPath(routerState: unknown, merchantId: string): string {
  const back = routerState as Partial<ReturnTo> | null | undefined;
  // Only paths on this site: '//host' would be another site's address.
  if (typeof back?.from !== 'string' || !back.from.startsWith('/') || back.from.startsWith('//')) {
    return '/';
  }
  const owner = back.merchantId ?? null;
  return owner === null || owner === merchantId ? back.from : '/';
}
