import { describe, expect, it } from 'vitest';

import {
  formatAmount,
  formatCard,
  isPaymentState,
  normalizeSearch,
  type Payment,
  paymentListPath,
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
