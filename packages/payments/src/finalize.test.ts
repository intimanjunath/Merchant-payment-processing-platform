import { planFinalization } from './finalize';

describe('planFinalization (spec §5.5 table)', () => {
  it('authorize succeeded: pending to authorized, provider payment ID set, 201', () => {
    expect(planFinalization('authorize', { outcome: 'succeeded', chargeId: 'ch_1' })).toEqual({
      kind: 'transition',
      event: 'authorization_confirmed',
      operationStatus: 'succeeded',
      operationReason: null,
      failureReason: null,
      providerPaymentId: 'ch_1',
      httpStatus: 201,
      scheduleSettlement: false,
    });
  });

  it.each([
    ['declined', { outcome: 'rejected', code: 'card_declined' } as const, 'card_declined'],
    ['not received', { outcome: 'not_received' } as const, 'authorization_not_received'],
  ])('authorize %s: pending to failed with the reason, still 201', (_label, result, reason) => {
    expect(planFinalization('authorize', result)).toEqual({
      kind: 'transition',
      event: 'authorization_failed',
      operationStatus: 'rejected',
      operationReason: reason,
      failureReason: reason,
      providerPaymentId: null,
      httpStatus: 201,
      scheduleSettlement: false,
    });
  });

  it.each([
    ['capture', 'capture_confirmed', true],
    ['refund', 'refund_confirmed', false],
  ] as const)(
    '%s succeeded: transition, 200, settlement only after capture',
    (action, event, settle) => {
      expect(planFinalization(action, { outcome: 'succeeded', chargeId: 'ch_1' })).toEqual({
        kind: 'transition',
        event,
        operationStatus: 'succeeded',
        operationReason: null,
        failureReason: null,
        providerPaymentId: null,
        httpStatus: 200,
        scheduleSettlement: settle,
      });
    },
  );

  it.each(['capture', 'refund'] as const)('%s rejected: no payment change', (action) => {
    expect(planFinalization(action, { outcome: 'rejected', code: 'rejected_by_provider' })).toEqual(
      {
        kind: 'rejection',
        operationReason: `${action}_rejected`,
        code: 'rejected_by_provider',
      },
    );
  });

  it.each(['capture', 'refund'] as const)('refuses "not received" as final for %s', (action) => {
    expect(() => planFinalization(action, { outcome: 'not_received' })).toThrow(
      `"not received" does not finalize a ${action}`,
    );
  });
});
