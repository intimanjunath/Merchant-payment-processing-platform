import {
  assertActionAllowed,
  INITIAL_STATE,
  InvalidStateTransitionError,
  PAYMENT_ACTIONS,
  PAYMENT_EVENTS,
  PAYMENT_STATES,
  type PaymentAction,
  type PaymentEvent,
  type PaymentState,
  transition,
} from './transitions';

// Written out from spec §3.1, independently of the implementation's table.
const ALLOWED_EVENTS: [PaymentState, PaymentEvent, PaymentState, string][] = [
  ['pending', 'authorization_confirmed', 'authorized', 'merchant'],
  ['pending', 'authorization_failed', 'failed', 'merchant'],
  ['authorized', 'capture_confirmed', 'captured', 'merchant'],
  ['captured', 'settlement_confirmed', 'settled', 'system:settlement'],
  ['settled', 'refund_confirmed', 'refunded', 'merchant'],
];
const ALLOWED_ACTIONS: [PaymentState, PaymentAction][] = [
  ['authorized', 'capture'],
  ['settled', 'refund'],
];

/** Runs `work`, expecting it to throw, and returns what it threw. */
function refusal(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a refusal');
}

const allPairs = <T extends string>(others: readonly T[]) =>
  PAYMENT_STATES.flatMap((state) => others.map((other) => [state, other] as const));

describe('payment transitions', () => {
  it('starts every payment as pending', () => {
    expect(INITIAL_STATE).toBe('pending');
  });

  describe.each(allPairs(PAYMENT_EVENTS))('state %s, event %s', (state, event) => {
    const allowed = ALLOWED_EVENTS.find(([from, e]) => from === state && e === event);

    if (allowed) {
      it(`moves to ${allowed[2]}`, () => {
        expect(transition(state, event)).toEqual({
          from: state,
          to: allowed[2],
          actor: allowed[3],
        });
      });
    } else {
      it('is refused with INVALID_STATE_TRANSITION', () => {
        expect(refusal(() => transition(state, event))).toMatchObject({
          code: 'INVALID_STATE_TRANSITION',
          state,
          attempted: event,
        });
      });
    }
  });

  describe.each(allPairs(PAYMENT_ACTIONS))('state %s, action %s', (state, action) => {
    const allowed = ALLOWED_ACTIONS.some(([from, a]) => from === state && a === action);

    it(allowed ? 'is allowed' : 'is refused with INVALID_STATE_TRANSITION', () => {
      if (allowed) {
        expect(() => {
          assertActionAllowed(state, action);
        }).not.toThrow();
      } else {
        expect(
          refusal(() => {
            assertActionAllowed(state, action);
          }),
        ).toMatchObject({ code: 'INVALID_STATE_TRANSITION', state, attempted: action });
      }
    });
  });

  it('covers all 30 (state, event) and 12 (state, action) pairs', () => {
    expect(allPairs(PAYMENT_EVENTS)).toHaveLength(30);
    expect(allPairs(PAYMENT_ACTIONS)).toHaveLength(12);
  });

  it('walks the full lifecycle, entering each state once', () => {
    let state: PaymentState = INITIAL_STATE;
    const visited = [state];
    for (const event of [
      'authorization_confirmed',
      'capture_confirmed',
      'settlement_confirmed',
      'refund_confirmed',
    ] as const) {
      state = transition(state, event).to;
      visited.push(state);
    }

    expect(visited).toEqual(['pending', 'authorized', 'captured', 'settled', 'refunded']);
  });

  it('never re-enters a state, so one audit row per (payment, to_state) is enough', () => {
    const targets = ALLOWED_EVENTS.map(([, , to]) => to);

    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).not.toContain(INITIAL_STATE);
  });

  it('is not changed by a caller modifying a returned transition', () => {
    const result = transition('authorized', 'capture_confirmed');
    result.from = 'pending';
    result.to = 'refunded';

    expect(transition('authorized', 'capture_confirmed').to).toBe('captured');
    expect(refusal(() => transition('pending', 'capture_confirmed'))).toBeInstanceOf(
      InvalidStateTransitionError,
    );
  });

  it('leaves failed and refunded with no way out', () => {
    for (const state of ['failed', 'refunded'] as const) {
      for (const event of PAYMENT_EVENTS) {
        expect(refusal(() => transition(state, event))).toBeInstanceOf(InvalidStateTransitionError);
      }
      for (const action of PAYMENT_ACTIONS) {
        expect(
          refusal(() => {
            assertActionAllowed(state, action);
          }),
        ).toBeInstanceOf(InvalidStateTransitionError);
      }
    }
  });
});
