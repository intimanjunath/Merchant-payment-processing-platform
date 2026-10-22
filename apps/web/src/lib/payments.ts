/** Payment states in lifecycle order (spec §3.1). */
export const PAYMENT_STATES = [
  'pending',
  'authorized',
  'captured',
  'settled',
  'refunded',
  'failed',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/** The Payment resource of spec §4.2. */
export interface Payment {
  id: string;
  state: PaymentState;
  amount: number;
  currency: string;
  reference: string;
  paymentMethod: { brand: string; last4: string };
  failureReason: 'card_declined' | 'authorization_not_received' | null;
  settlementReview: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One page of GET /payments. */
export interface PaymentPage {
  items: Payment[];
  nextCursor: string | null;
}

export interface ListQuery {
  status: PaymentState | null;
  q: string | null;
  cursor: string | null;
  limit: number;
}

/** The API's search limit (spec §4.4). */
export const SEARCH_MAX_LENGTH = 100;

export const STATE_LABELS: Record<PaymentState, string> = {
  pending: 'Pending',
  authorized: 'Authorized',
  captured: 'Captured',
  settled: 'Settled',
  refunded: 'Refunded',
  failed: 'Failed',
};

const FAILURE_LABELS: Record<NonNullable<Payment['failureReason']>, string> = {
  card_declined: 'Declined by the card’s bank',
  authorization_not_received: 'Never reached the bank',
};

export function isPaymentState(value: string | null): value is PaymentState {
  return value !== null && (PAYMENT_STATES as readonly string[]).includes(value);
}

/** The GET /payments path for a query; empty filters are left out, as the API expects. */
export function paymentListPath(query: ListQuery): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  const q = normalizeSearch(query.q);
  if (q) params.set('q', q);
  params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return `/payments?${params.toString()}`;
}

/** Trimmed and capped at the API's limit; blank means no search. */
export function normalizeSearch(value: string | null): string | null {
  const trimmed = value?.trim().slice(0, SEARCH_MAX_LENGTH).trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Integer cents as money, for example 129900 USD → "$1,299.00". */
export function formatAmount(cents: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

export function formatCard(method: Payment['paymentMethod']): string {
  const brand = method.brand.charAt(0).toUpperCase() + method.brand.slice(1);
  return `${brand} •••• ${method.last4}`;
}

/** A short line under the state, when there is more to say. */
export function stateNote(payment: Payment): string | null {
  if (payment.failureReason) return FAILURE_LABELS[payment.failureReason];
  if (payment.settlementReview) return 'Settlement under review';
  return null;
}
