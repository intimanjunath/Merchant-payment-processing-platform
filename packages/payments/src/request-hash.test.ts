import { createHash } from 'node:crypto';

import { actionRequestHash, createRequestHash, requestHash } from './request-hash';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('requestHash', () => {
  it('hashes the JSON with sorted keys', () => {
    expect(requestHash({ reference: 'order-1', amount: 1500 })).toBe(
      sha256('{"amount":1500,"reference":"order-1"}'),
    );
  });

  it('ignores property order', () => {
    expect(requestHash({ a: 1, b: 'x', c: 2 })).toBe(requestHash({ c: 2, a: 1, b: 'x' }));
  });

  it('tells a number from the same digits as a string', () => {
    expect(requestHash({ amount: 1500 })).not.toBe(requestHash({ amount: '1500' }));
  });
});

describe('createRequestHash', () => {
  const base = { amount: 1500, reference: 'order-1042', paymentMethod: 'pm_card_visa' };

  it('trims the reference, so surrounding spaces are the same request', () => {
    expect(createRequestHash({ ...base, reference: '  order-1042 ' })).toBe(
      createRequestHash(base),
    );
  });

  it.each([
    ['amount', { amount: 1501 }],
    ['reference', { reference: 'order-1043' }],
    ['reference case', { reference: 'ORDER-1042' }],
    ['payment method', { paymentMethod: 'pm_card_declined' }],
  ])('changes when the %s changes', (_label, change) => {
    expect(createRequestHash({ ...base, ...change })).not.toBe(createRequestHash(base));
  });
});

describe('actionRequestHash', () => {
  const paymentId = '0192f0c4-7a1e-7c3b-9a8d-2f4b6c8e1a20';

  it('differs between capture and refund of one payment', () => {
    expect(actionRequestHash({ action: 'capture', paymentId })).not.toBe(
      actionRequestHash({ action: 'refund', paymentId }),
    );
  });

  it('differs between payments', () => {
    expect(actionRequestHash({ action: 'capture', paymentId })).not.toBe(
      actionRequestHash({ action: 'capture', paymentId: paymentId.replace('a20', 'a21') }),
    );
  });
});
