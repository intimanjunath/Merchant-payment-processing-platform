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

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A timestamp in the viewer's locale and time zone, for example "Oct 22, 2026, 2:15 AM". */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
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

/** Router state the list hands to a payment's page, so "Back to payments" keeps its filters. */
export interface FromList {
  listSearch: string;
}

/** The Operation resource of spec §4.2. */
export interface Operation {
  id: string;
  action: 'authorize' | 'capture' | 'refund';
  status: 'reserved' | 'awaiting_confirmation' | 'needs_review' | 'succeeded' | 'rejected';
  reason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** The Transition resource of spec §4.2: one audit row. */
export interface Transition {
  fromState: PaymentState | null;
  toState: PaymentState;
  actor: string;
  source: 'api' | 'worker';
  reason: string;
  requestId: string | null;
  occurredAt: string;
}

/** GET /payments/{id}. */
export interface PaymentDetails {
  payment: Payment;
  pendingOperation: Operation | null;
  operations: Operation[];
  transitions: Transition[];
}

const UNRESOLVED_OPERATION: ReadonlySet<Operation['status']> = new Set([
  'reserved',
  'awaiting_confirmation',
  'needs_review',
]);

/**
 * Whether something may still change without the merchant doing anything:
 * the bank's answer is outstanding, a captured payment is waiting to settle,
 * or an operation is unresolved (including one paused for review).
 */
export function isUnresolved(details: PaymentDetails): boolean {
  if (details.pendingOperation && UNRESOLVED_OPERATION.has(details.pendingOperation.status)) {
    return true;
  }
  return details.payment.state === 'pending' || details.payment.state === 'captured';
}

export const ACTION_LABELS: Record<Operation['action'], string> = {
  authorize: 'Authorize',
  capture: 'Capture',
  refund: 'Refund',
};

/** The action as a noun, for sentences: "the authorization is paused". */
export const ACTION_NOUNS: Record<Operation['action'], string> = {
  authorize: 'authorization',
  capture: 'capture',
  refund: 'refund',
};

export const OPERATION_STATUS_LABELS: Record<Operation['status'], string> = {
  reserved: 'Sent to the bank',
  awaiting_confirmation: 'Waiting for the bank to confirm',
  needs_review: 'Paused for review',
  succeeded: 'Succeeded',
  rejected: 'Rejected',
};

const REASON_LABELS: Record<string, string> = {
  create_accepted: 'Payment created',
  authorization_confirmed: 'The bank approved it',
  authorization_failed: 'The bank did not approve it',
  capture_confirmed: 'Capture confirmed',
  settlement_confirmed: 'Funds reached your account',
  refund_confirmed: 'Refund confirmed',
  provider_timeout: 'The bank didn’t answer in time',
  provider_unavailable: 'The bank couldn’t be reached',
  capture_rejected: 'The bank refused the capture',
  refund_rejected: 'The bank refused the refund',
  card_declined: 'Declined by the card’s bank',
  authorization_not_received: 'The request never reached the bank',
  retries_exhausted: 'Stopped after repeated failures',
  review_deadline_reached: 'Took too long to confirm',
};

/** A reason code in the merchant's words; an unknown code is shown as it is. */
export function reasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return REASON_LABELS[reason] ?? reason;
}

/** Who made a change: the merchant through the API, or the platform on its own. */
export function actorLabel(transition: Pick<Transition, 'actor' | 'source'>): string {
  if (transition.actor.startsWith('system:')) return 'Automatically';
  return transition.source === 'worker' ? 'By you, confirmed later by the platform' : 'By you';
}

/** When the payment entered each state, from its audit trail. */
export function reachedAt(transitions: Transition[]): Partial<Record<PaymentState, string>> {
  const reached: Partial<Record<PaymentState, string>> = {};
  for (const transition of transitions) reached[transition.toState] = transition.occurredAt;
  return reached;
}

/** The API's amount range in cents (design §10): $0.01 to $1,000,000.00. */
export const AMOUNT_MIN_CENTS = 1;
export const AMOUNT_MAX_CENTS = 100_000_000;

/**
 * Dollars as typed ("12.5", "$1,299.00") to integer cents, without floating
 * point; null for anything that isn't an amount in the API's range.
 */
export function parseAmount(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '').replaceAll(',', '');
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const [, whole = '0', fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return cents >= AMOUNT_MIN_CENTS && cents <= AMOUNT_MAX_CENTS ? cents : null;
}
