import { describe, expect, it } from 'vitest';

import {
  actorLabel,
  formatAmount,
  formatCard,
  isPaymentState,
  isUnresolved,
  normalizeSearch,
  type Payment,
  type PaymentDetails,
  parseAmount,
  paymentListPath,
  reachedAt,
  reasonLabel,
  stateNote,
} from './payments';

const payment: Payment = {
  id: 'p1',
  state: 'authorized',
  amount: 1500,
  currency: 'USD',
  reference: 'order-1042',
  paymentMethod: { brand: 'visa', last4: '4242' },
  failureReason: null,
  settlementReview: false,
  createdAt: '2026-10-21T17:04:05.123Z',
  updatedAt: '2026-10-21T17:04:05.481Z',
};

describe('paymentListPath', () => {
  it('sends only the filters that are set', () => {
    expect(paymentListPath({ status: null, q: null, cursor: null, limit: 25 })).toBe(
      '/payments?limit=25',
    );
    expect(paymentListPath({ status: 'captured', q: ' ACME ', cursor: 'abc.def', limit: 25 })).toBe(
      '/payments?status=captured&q=ACME&limit=25&cursor=abc.def',
    );
  });

  it('encodes search text and leaves out a blank search', () => {
    expect(paymentListPath({ status: null, q: 'a&b c', cursor: null, limit: 10 })).toBe(
      '/payments?q=a%26b+c&limit=10',
    );
    expect(paymentListPath({ status: null, q: '   ', cursor: null, limit: 10 })).toBe(
      '/payments?limit=10',
    );
  });
});

describe('normalizeSearch', () => {
  it('trims, caps at 100 characters and treats blank as none', () => {
    expect(normalizeSearch('  bike ')).toBe('bike');
    expect(normalizeSearch('')).toBeNull();
    expect(normalizeSearch(null)).toBeNull();
    expect(normalizeSearch('x'.repeat(150))).toHaveLength(100);
  });
});

describe('isPaymentState', () => {
  it('accepts only lifecycle states', () => {
    expect(isPaymentState('settled')).toBe(true);
    expect(isPaymentState('Settled')).toBe(false);
    expect(isPaymentState('cancelled')).toBe(false);
    expect(isPaymentState(null)).toBe(false);
  });
});

describe('formatting', () => {
  it('shows integer cents as dollars', () => {
    expect(formatAmount(129_900, 'USD', 'en-US')).toBe('$1,299.00');
    expect(formatAmount(5, 'USD', 'en-US')).toBe('$0.05');
  });

  it('shows the card brand and last four only', () => {
    expect(formatCard({ brand: 'amex', last4: '0005' })).toBe('Amex •••• 0005');
  });

  it('explains failures and settlement review', () => {
    expect(stateNote(payment)).toBeNull();
    expect(stateNote({ ...payment, state: 'failed', failureReason: 'card_declined' })).toBe(
      'Declined by the card’s bank',
    );
    expect(
      stateNote({ ...payment, state: 'failed', failureReason: 'authorization_not_received' }),
    ).toBe('Never reached the bank');
    expect(stateNote({ ...payment, state: 'captured', settlementReview: true })).toBe(
      'Settlement under review',
    );
  });
});

describe('details helpers', () => {
  const details = (
    state: Payment['state'],
    pending: PaymentDetails['pendingOperation'] = null,
  ) => ({
    payment: { ...payment, state },
    pendingOperation: pending,
    operations: [],
    transitions: [],
  });
  const operation = (status: NonNullable<PaymentDetails['pendingOperation']>['status']) => ({
    id: 'op',
    action: 'capture' as const,
    status,
    reason: null,
    createdAt: payment.createdAt,
    completedAt: null,
  });

  it('counts pending, captured and unresolved operations as unresolved', () => {
    expect(isUnresolved(details('pending'))).toBe(true);
    expect(isUnresolved(details('captured'))).toBe(true);
    expect(isUnresolved(details('authorized', operation('awaiting_confirmation')))).toBe(true);
    expect(isUnresolved(details('authorized', operation('needs_review')))).toBe(true);
    for (const state of ['authorized', 'settled', 'refunded', 'failed'] as const) {
      expect(isUnresolved(details(state))).toBe(false);
    }
  });

  it('records when each state was reached', () => {
    expect(
      reachedAt([
        {
          fromState: null,
          toState: 'pending',
          actor: 'merchant:m',
          source: 'api',
          reason: 'create_accepted',
          requestId: 'r1',
          occurredAt: 't1',
        },
        {
          fromState: 'pending',
          toState: 'authorized',
          actor: 'merchant:m',
          source: 'worker',
          reason: 'authorization_confirmed',
          requestId: 'r1',
          occurredAt: 't2',
        },
      ]),
    ).toEqual({ pending: 't1', authorized: 't2' });
  });

  it('names actors and reasons in the merchant’s words', () => {
    expect(actorLabel({ actor: 'system:settlement', source: 'worker' })).toBe('Automatically');
    expect(actorLabel({ actor: 'merchant:m', source: 'api' })).toBe('By you');
    expect(actorLabel({ actor: 'merchant:m', source: 'worker' })).toBe(
      'By you, confirmed later by the platform',
    );
    expect(reasonLabel('settlement_confirmed')).toBe('Funds reached your account');
    expect(reasonLabel('something_new')).toBe('something_new');
    expect(reasonLabel(null)).toBeNull();
  });
});

describe('parseAmount', () => {
  it('turns typed dollars into integer cents', () => {
    expect(parseAmount('12.5')).toBe(1250);
    expect(parseAmount('$1,299.00')).toBe(129_900);
    expect(parseAmount(' 0.01 ')).toBe(1);
    expect(parseAmount('1000000')).toBe(100_000_000);
    expect(parseAmount('0.29')).toBe(29);
  });

  it('refuses anything outside the API’s range or not an amount', () => {
    for (const text of ['', '0', '0.00', '1000000.01', '1.234', '-5', 'abc', '1e3', '12.', '.5']) {
      expect(parseAmount(text)).toBeNull();
    }
  });
});
